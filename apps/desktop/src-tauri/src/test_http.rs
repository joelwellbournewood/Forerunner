//! A small HTTP/1.1 server on 127.0.0.1 for the shell's unit tests (tests only): canned answers
//! per route, an answer after a delay, a connection that is accepted and never answered (a hung
//! daemon), and a server that stops listening once it answered a route (a daemon that exits
//! after `POST /shutdown`). Only std; one thread per connection; every answer closes the
//! connection so the client never reuses one.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a hung answer holds the connection before the thread gives up.
const HANG_LIMIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct Route {
    pub method: &'static str,
    pub path: &'static str,
    pub status: u16,
    pub body: String,
    /// Wait this long before answering.
    pub delay: Duration,
    /// Accept and read the request, then never answer.
    pub hang: bool,
    /// Stop listening once this route was answered: later connections are refused.
    pub then_close: bool,
}

impl Route {
    pub fn json(method: &'static str, path: &'static str, status: u16, body: &str) -> Self {
        Self {
            method,
            path,
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
            hang: false,
            then_close: false,
        }
    }

    pub fn hanging(mut self) -> Self {
        self.hang = true;
        self
    }

    pub fn then_close(mut self) -> Self {
        self.then_close = true;
        self
    }
}

/// A healthy `/health` answer as the daemon sends it.
pub fn health_body(active_sessions: u64) -> String {
    format!(
        r#"{{"ok":true,"version":"1.0.4","platform":"linux","killActive":false,"activeSessions":{active_sessions}}}"#
    )
}

pub struct TestServer {
    pub url: String,
    /// "METHOD /path" of every request read, in order.
    pub requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
}

impl TestServer {
    pub fn start(routes: Vec<Route>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("local addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (reqs, stop_flag) = (requests.clone(), stop.clone());
        std::thread::spawn(move || {
            // The listener is dropped when this loop ends, so new connections are refused.
            while !stop_flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (routes, reqs, stop_flag) =
                            (routes.clone(), reqs.clone(), stop_flag.clone());
                        std::thread::spawn(move || serve(stream, &routes, &reqs, &stop_flag));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
            requests,
            stop,
        }
    }

    pub fn seen(&self) -> Vec<String> {
        self.requests.lock().map(|r| r.clone()).unwrap_or_default()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn serve(mut stream: TcpStream, routes: &[Route], reqs: &Mutex<Vec<String>>, stop: &AtomicBool) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Some((method, path)) = read_request(&mut stream) else {
        return;
    };
    if let Ok(mut r) = reqs.lock() {
        r.push(format!("{method} {path}"));
    }
    let route = routes
        .iter()
        .find(|r| r.method == method && r.path == path)
        .cloned()
        .unwrap_or_else(|| {
            Route::json(
                "GET",
                "/",
                404,
                r#"{"code":"not_found","message":"no route"}"#,
            )
        });
    if route.hang {
        let started = Instant::now();
        while !stop.load(Ordering::SeqCst) && started.elapsed() < HANG_LIMIT {
            std::thread::sleep(Duration::from_millis(20));
        }
        return;
    }
    std::thread::sleep(route.delay);
    let reason = if route.status < 300 { "OK" } else { "Error" };
    let answer = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        route.status,
        route.body.len(),
        route.body
    );
    let _ = stream.write_all(answer.as_bytes());
    let _ = stream.flush();
    if route.then_close {
        stop.store(true, Ordering::SeqCst);
    }
}

/// The request line and the body (read up to Content-Length, then discarded).
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let length = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut have = buf.len() - header_end;
    while have < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        have += n;
    }
    let mut first = head.lines().next()?.split_whitespace();
    Some((first.next()?.to_string(), first.next()?.to_string()))
}
