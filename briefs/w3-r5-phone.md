## title

The phone contributes: upload photos, files and documents to a project; review PRs and critic findings; voice turns relayed to the PC

## requirements

R.5 (R.3, R.4, O.x context)

## adr

0080

## brief

BLOCKERS.md row R.5 phone uploads, PR and critic review, voice: **partly built** (requirements close-out 2026-10-20): quick chat relayed to the PC, natural-language control, notes to the next-session queue, answering requests and the change log are tested on the phone (`apps/ui/test/mobile-chat.test.tsx`, `mobile-intent.test.ts`, `mobile-inbox.test.tsx`, `mobile-store.test.ts`) and the service has the upload and review routes (`services/state-api/test/routes.test.ts`); the phone UI has no upload screen, no PR / critic review screen, and its Chat screen is text only (voice on the phone is module O's loop, which runs on the PC). Stand-in: uploads and reviews from the desktop app or the approvals web page; voice from the desktop. Needed: upload and review screens in `apps/ui/src/mobile/screens` over the service routes, and voice turns relayed as audio or a typed line through the PC's `/voice` routes, each with a `mobile-*.test.tsx`; then the emulator run; then R.5 `done`. Spec R.5: 'Contribute: chat and voice with your agent (module O). Natural-language control (module Q). Add notes, tasks and ideas. Upload photos, files and documents to a project. Review PRs and critic findings, comment, approve or reject. Answer human requests.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read apps/ui/src/mobile (MobileApp.tsx routes, screens, store.tsx, the signed request client state-client.ts, outbox.ts for offline, shell-bridge.ts for what the Android shell offers: Keystore, biometric; is there a file picker or a share-target bridge? if not, use the web file input and note the shell hook as follow-up), services/state-api/src/routes (the upload route: multipart or base64, size caps, where the file lands: the project's data assets; the review routes: list reviews/findings per project, approve/reject with the signed answer; comment), apps/ui/test/mobile-*.test.tsx conventions (the fake state service), the voice relay: the approvals web of ADR 0034 relays chat as a remote command; for voice, relay a recorded turn as audio (the MediaRecorder stand-in in tests) to the PC's /voice route through the remote command path, or as a typed transcript line when the phone has no recorder (decide, record in ADR 0080). Build: an Upload screen (pick a file/photo, name, project, send to the service's upload route signed; progress; offline queued through the outbox; size cap shown), a Reviews screen (open PRs of the project with the critic's findings, comment, approve or reject: high risk answers follow the biometric rule of ADR 0045), the Chat screen gains a push-to-talk that relays the turn to the PC (audio when the shell provides it, else the typed line) and plays the PC's reply text; each screen reachable from the nav. Tests: apps/ui/test/mobile-upload.test.tsx, mobile-reviews.test.tsx, mobile-voice.test.tsx. Docs: apps.md (Android app), state-service.md if a route changes. ADR 0080.

## paths

apps/ui/src/mobile/screens, apps/ui/src/mobile, services/state-api/src/routes, tests
