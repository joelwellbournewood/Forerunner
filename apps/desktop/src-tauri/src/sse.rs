//! Server-sent events from `GET /events` (ADR 0011, ADR 0031): an incremental parser for
//! `text/event-stream` bodies, mirroring `SseParser` in `apps/ui/src/api/sse.ts`, and the
//! typed subset of daemon events the shell acts on. Unknown events are reported as `Other` and
//! ignored; malformed data is dropped, never shown.

use serde_json::Value;

use crate::deeplink::is_safe_route;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
}

/// Longest line the parser keeps while waiting for its newline. The daemon's frames are a few
/// kilobytes; a line past this is dropped together with the frame it belongs to, so a stream
/// that never sends a newline cannot grow the buffer without bound.
pub const MAX_LINE: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
    /// Bytes of an incomplete UTF-8 sequence at the end of the last chunk (`feed_bytes`).
    pending: Vec<u8>,
    /// The current line went past `MAX_LINE`: its rest is skipped up to the next newline.
    overflow: bool,
    event: Option<String>,
    data: Vec<String>,
    id: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw bytes as they come off the socket. A chunk may end in the middle of a
    /// multi-byte character (reqwest splits at arbitrary byte offsets): only the longest
    /// valid UTF-8 prefix is decoded and the rest waits for the next chunk. A byte sequence
    /// that can never be valid becomes U+FFFD, so a corrupt byte cannot stall the stream.
    pub fn feed_bytes(&mut self, chunk: &[u8]) -> Vec<SseFrame> {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut text = String::new();
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    text.push_str(s);
                    break;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    text.push_str(std::str::from_utf8(&rest[..good]).unwrap_or(""));
                    match e.error_len() {
                        Some(bad) => {
                            text.push('\u{fffd}');
                            rest = &rest[good + bad..];
                        }
                        None => {
                            self.pending = rest[good..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        self.feed(&text)
    }

    /// Feed a chunk; returns every frame completed by it.
    pub fn feed(&mut self, chunk: &str) -> Vec<SseFrame> {
        self.buffer
            .push_str(&chunk.replace("\r\n", "\n").replace('\r', "\n"));
        let mut frames = Vec::new();
        while let Some(idx) = self.buffer.find('\n') {
            let line = self.buffer[..idx].to_string();
            self.buffer.drain(..=idx);
            if self.overflow {
                // The rest of a line that was dropped; the frame it belonged to is gone too.
                self.overflow = false;
                continue;
            }
            if let Some(frame) = self.line(&line) {
                frames.push(frame);
            }
        }
        if self.buffer.len() > MAX_LINE {
            log::warn!(
                "/events line longer than {MAX_LINE} bytes dropped (event {:?})",
                self.event
            );
            self.buffer.clear();
            self.overflow = true;
            self.event = None;
            self.data.clear();
            self.id = None;
        }
        frames
    }

    /// Bytes held while waiting for a newline or the rest of a character; bounded by
    /// `MAX_LINE` plus one character.
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len() + self.pending.len()
    }

    /// Flush a trailing frame without a final blank line.
    pub fn end(&mut self) -> Vec<SseFrame> {
        let mut frames = self.feed("\n");
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            if let Some(frame) = self.line(&rest) {
                frames.push(frame);
            }
        }
        if let Some(last) = self.dispatch() {
            frames.push(last);
        }
        frames
    }

    fn line(&mut self, line: &str) -> Option<SseFrame> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(i) => (
                &line[..i],
                line[i + 1..].strip_prefix(' ').unwrap_or(&line[i + 1..]),
            ),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            "id" => self.id = Some(value.to_string()),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseFrame> {
        if self.data.is_empty() {
            self.event = None;
            return None;
        }
        let frame = SseFrame {
            event: self.event.take().unwrap_or_else(|| "message".to_string()),
            data: std::mem::take(&mut self.data).join("\n"),
            id: self.id.take(),
        };
        Some(frame)
    }
}

/// A `notification` event: what the daemon's notification module decided to deliver to the
/// desktop channel (quiet hours and channel choice are the daemon's; the shell shows what it
/// receives). Fields: `title` (required), `body`, `level`, `route` (a UI route to open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationEvent {
    pub title: String,
    pub body: String,
    pub level: String,
    pub route: Option<String>,
}

pub const TITLE_MAX: usize = 200;
pub const BODY_MAX: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonEvent {
    Notification(NotificationEvent),
    RestartRequested {
        reason: String,
        target_version: String,
        exit_code: Option<i32>,
    },
    InboxChanged {
        blocking_count: u64,
    },
    Heartbeat,
    Other(String),
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Typed view of one frame; `None` when the data is not usable.
pub fn parse_daemon_event(frame: &SseFrame) -> Option<DaemonEvent> {
    match frame.event.as_str() {
        "heartbeat" => Some(DaemonEvent::Heartbeat),
        "notification" => {
            let v: Value = serde_json::from_str(&frame.data).ok()?;
            let title = v.get("title").and_then(Value::as_str)?.trim();
            if title.is_empty() {
                return None;
            }
            let body = v.get("body").and_then(Value::as_str).unwrap_or("").trim();
            let level = v
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info")
                .to_string();
            let route = v
                .get("route")
                .and_then(Value::as_str)
                .filter(|r| is_safe_route(r))
                .map(str::to_string);
            Some(DaemonEvent::Notification(NotificationEvent {
                title: truncate(title, TITLE_MAX),
                body: truncate(body, BODY_MAX),
                level,
                route,
            }))
        }
        "restart.requested" => {
            let v: Value = serde_json::from_str(&frame.data).ok()?;
            Some(DaemonEvent::RestartRequested {
                reason: v
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("update")
                    .to_string(),
                target_version: v
                    .get("targetVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                exit_code: v
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .and_then(|c| i32::try_from(c).ok()),
            })
        }
        "inbox.changed" => {
            let v: Value = serde_json::from_str(&frame.data).ok()?;
            Some(DaemonEvent::InboxChanged {
                blocking_count: v.get("blockingCount").and_then(Value::as_u64)?,
            })
        }
        other => Some(DaemonEvent::Other(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frames_across_chunks_and_comments() {
        let mut p = SseParser::new();
        let mut frames =
            p.feed("event: heartbeat\ndata: {\"at\":\"x\"}\n\n: comment\nevent: notifi");
        frames
            .extend(p.feed("cation\r\ndata: {\"title\":\"A\",\r\ndata:  \"body\":\"B\"}\r\n\r\n"));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].event, "heartbeat");
        assert_eq!(frames[0].data, r#"{"at":"x"}"#);
        assert_eq!(frames[1].event, "notification");
        assert_eq!(frames[1].data, "{\"title\":\"A\",\n \"body\":\"B\"}");
        assert!(p.feed("id: 7\ndata: tail").is_empty());
        let tail = p.end();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].event, "message");
        assert_eq!(tail[0].id.as_deref(), Some("7"));
        assert_eq!(tail[0].data, "tail");
    }

    /// reqwest hands the body over in chunks cut at arbitrary byte offsets; a chunk that ends
    /// inside "Ü" must not turn the title into "��berprüfen" (decoding each chunk on its own
    /// did exactly that).
    #[test]
    fn bytes_split_inside_a_multibyte_character_are_decoded_whole() {
        let frame = "event: notification\ndata: {\"title\":\"Überprüfen\",\"body\":\"CHF 1’200…\"}\n\n";
        let bytes = frame.as_bytes();
        let cut = frame.find('Ü').expect("umlaut") + 1; // between the two bytes of 'Ü'
        let mut p = SseParser::new();
        let mut frames = p.feed_bytes(&bytes[..cut]);
        assert!(frames.is_empty());
        assert_eq!(p.buffered_bytes(), cut);
        frames.extend(p.feed_bytes(&bytes[cut..]));
        assert_eq!(frames.len(), 1);
        match parse_daemon_event(&frames[0]) {
            Some(DaemonEvent::Notification(n)) => {
                assert_eq!(n.title, "Überprüfen");
                assert_eq!(n.body, "CHF 1’200…");
            }
            other => panic!("unexpected {other:?}"),
        }
        // One byte at a time, through the three-byte "…" and the two-byte "ü".
        let mut p = SseParser::new();
        let mut frames = Vec::new();
        for b in bytes {
            frames.extend(p.feed_bytes(std::slice::from_ref(b)));
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].data,
            "{\"title\":\"Überprüfen\",\"body\":\"CHF 1’200…\"}"
        );
        assert_eq!(p.buffered_bytes(), 0);
    }

    #[test]
    fn invalid_bytes_become_replacement_characters_without_stalling() {
        let mut p = SseParser::new();
        let mut bytes = b"data: a".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b"b\n\n");
        let frames = p.feed_bytes(&bytes);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "a\u{fffd}b");
        // A truncated sequence that never completes is replaced when the next line starts.
        let mut p = SseParser::new();
        assert!(p.feed_bytes(b"data: x\xc3").is_empty());
        let frames = p.feed_bytes(b"\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "x\u{fffd}");
    }

    #[test]
    fn a_line_above_the_cap_is_dropped_and_the_parser_recovers() {
        let mut p = SseParser::new();
        let huge = "x".repeat(MAX_LINE + 10);
        assert!(
            p.feed(&format!("event: notification\ndata: {huge}"))
                .is_empty()
        );
        assert!(p.buffered_bytes() <= MAX_LINE, "{}", p.buffered_bytes());
        // More of the same line still arrives and is skipped; the frame after it is intact.
        assert!(p.feed("yyyy").is_empty());
        assert!(p.buffered_bytes() <= MAX_LINE);
        let frames = p.feed("\n\ndata: ok\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "ok");
        assert_eq!(
            frames[0].event, "message",
            "the dropped frame's event name does not leak"
        );
        // Bytes without a newline are capped the same way.
        let mut p = SseParser::new();
        let big = vec![b'z'; MAX_LINE + 1];
        assert!(p.feed_bytes(&big).is_empty());
        assert!(p.buffered_bytes() <= MAX_LINE);
    }

    #[test]
    fn blank_frames_and_events_without_data_are_dropped() {
        let mut p = SseParser::new();
        assert!(p.feed("event: ghost\n\n\n\n").is_empty());
        let f = p.feed("data: x\n\n");
        assert_eq!(
            f[0].event, "message",
            "the ghost event name does not leak into the next frame"
        );
    }

    #[test]
    fn notification_events_are_validated_and_truncated() {
        let frame = |data: &str| SseFrame {
            event: "notification".into(),
            data: data.into(),
            id: None,
        };
        let ev = parse_daemon_event(&frame(
            r#"{"title":" Needs you ","body":"Approve the PR","level":"escalation","route":"/inbox"}"#,
        ));
        assert_eq!(
            ev,
            Some(DaemonEvent::Notification(NotificationEvent {
                title: "Needs you".into(),
                body: "Approve the PR".into(),
                level: "escalation".into(),
                route: Some("/inbox".into()),
            }))
        );
        assert_eq!(parse_daemon_event(&frame(r#"{"body":"no title"}"#)), None);
        assert_eq!(parse_daemon_event(&frame(r#"{"title":"   "}"#)), None);
        assert_eq!(parse_daemon_event(&frame("not json")), None);
        let long = "x".repeat(5000);
        match parse_daemon_event(&frame(&format!(r#"{{"title":"{long}","body":"{long}"}}"#))) {
            Some(DaemonEvent::Notification(n)) => {
                assert_eq!(n.title.chars().count(), TITLE_MAX);
                assert_eq!(n.body.chars().count(), BODY_MAX);
                assert!(n.title.ends_with('…'));
            }
            other => panic!("unexpected {other:?}"),
        }
        match parse_daemon_event(&frame(r#"{"title":"t","route":"https://evil.example/x"}"#)) {
            Some(DaemonEvent::Notification(n)) => assert_eq!(n.route, None),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn restart_inbox_heartbeat_and_unknown_events() {
        let f = |event: &str, data: &str| SseFrame {
            event: event.into(),
            data: data.into(),
            id: None,
        };
        assert_eq!(
            parse_daemon_event(&f(
                "restart.requested",
                r#"{"reason":"update","targetVersion":"0.2.0","fromVersion":"0.1.0","exitCode":86}"#
            )),
            Some(DaemonEvent::RestartRequested {
                reason: "update".into(),
                target_version: "0.2.0".into(),
                exit_code: Some(86)
            })
        );
        assert_eq!(
            parse_daemon_event(&f("inbox.changed", r#"{"blockingCount":3}"#)),
            Some(DaemonEvent::InboxChanged { blocking_count: 3 })
        );
        assert_eq!(parse_daemon_event(&f("inbox.changed", r#"{}"#)), None);
        assert_eq!(
            parse_daemon_event(&f("heartbeat", "{}")),
            Some(DaemonEvent::Heartbeat)
        );
        assert_eq!(
            parse_daemon_event(&f("session.event", "{}")),
            Some(DaemonEvent::Other("session.event".into()))
        );
    }
}
