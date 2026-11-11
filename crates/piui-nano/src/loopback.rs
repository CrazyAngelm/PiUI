//! The one-shot OAuth redirect listener on `127.0.0.1` (RFC 8252 section 7.3).

use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::error::NanoError;
use crate::secret::SecretString;
use crate::wire::NANO_REDIRECT_PATH;

/// How long the browser has to come back.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Largest request head the listener reads.
pub const MAX_REQUEST_HEAD: usize = 8 * 1024;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);

const SUCCESS_PAGE: &str = "Signed in. You can close this tab and return to Nano Desktop.";
const FAILURE_PAGE: &str = "Sign-in did not complete. Return to Nano Desktop and try again.";
const CANCELLED_PAGE: &str = "Sign-in was cancelled. You can close this tab.";

/// The authorization code from the callback. `Debug` is redacted.
#[derive(Debug, Clone)]
pub struct AuthorizationCode(pub SecretString);

/// A bound redirect listener.
#[derive(Debug)]
pub struct CallbackListener {
    listener: TcpListener,
    port: u16,
}

/// What one connection produced.
enum Outcome {
    /// Not the callback (wrong path, wrong state...); keep waiting.
    Ignored,
    /// The flow is over.
    Done(Result<AuthorizationCode, NanoError>),
}

impl CallbackListener {
    /// Binds `127.0.0.1:0`.
    ///
    /// # Errors
    /// [`NanoError::SignInFailed`] when no loopback port can be bound.
    pub async fn bind() -> Result<Self, NanoError> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .map_err(|_| NanoError::SignInFailed)?;
        let port = listener
            .local_addr()
            .map_err(|_| NanoError::SignInFailed)?
            .port();
        Ok(Self { listener, port })
    }

    /// The bound port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:<port>/callback`.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{NANO_REDIRECT_PATH}", self.port)
    }

    /// Serves connections until a callback carrying `expected_state`
    /// arrives, `timeout` passes or `cancel` completes.
    ///
    /// Only `GET /callback` is answered with a page; other paths are 404.
    /// A callback with a missing or wrong `state` is refused and waiting
    /// continues, so a local process cannot end a sign-in. `iss`
    /// (RFC 9207) is mandatory on success and error responses alike and must
    /// equal `expected_issuer`.
    ///
    /// # Errors
    /// [`NanoError::SignInCancelled`] for `error=access_denied` or `cancel`,
    /// [`NanoError::SignInTimeout`] after `timeout`,
    /// [`NanoError::SignInFailed`] for any other authorization error or a
    /// missing or different issuer.
    pub async fn wait(
        self,
        expected_state: &SecretString,
        expected_issuer: &str,
        timeout: Duration,
        cancel: impl Future<Output = ()> + Send,
    ) -> Result<AuthorizationCode, NanoError> {
        let expected = Arc::new(Expected {
            state: expected_state.clone(),
            issuer: expected_issuer.trim_end_matches('/').to_owned(),
        });
        let (tx, mut rx) = mpsc::channel::<Result<AuthorizationCode, NanoError>>(1);
        let mut connections = JoinSet::new();
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        tokio::pin!(cancel);
        loop {
            tokio::select! {
                () = &mut deadline => return Err(NanoError::SignInTimeout),
                () = &mut cancel => return Err(NanoError::SignInCancelled),
                Some(result) = rx.recv() => return result,
                accepted = self.listener.accept() => {
                    let Ok((stream, peer)) = accepted else { continue };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let expected = expected.clone();
                    let tx = tx.clone();
                    connections.spawn(async move {
                        let outcome = tokio::time::timeout(CONNECTION_TIMEOUT, serve(stream, &expected))
                            .await
                            .unwrap_or(Outcome::Ignored);
                        if let Outcome::Done(result) = outcome {
                            let _ = tx.send(result).await;
                        }
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    }
}

struct Expected {
    state: SecretString,
    issuer: String,
}

async fn serve(mut stream: TcpStream, expected: &Expected) -> Outcome {
    let Some(head) = read_head(&mut stream).await else {
        let _ = respond(&mut stream, 431, "Request Header Fields Too Large", None).await;
        return Outcome::Ignored;
    };
    let mut request_line = head.split("\r\n").next().unwrap_or_default().split(' ');
    let (method, target) = (
        request_line.next().unwrap_or_default(),
        request_line.next().unwrap_or_default(),
    );
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != NANO_REDIRECT_PATH {
        let _ = respond(&mut stream, 404, "Not Found", None).await;
        return Outcome::Ignored;
    }
    if method != "GET" {
        let _ = respond(&mut stream, 405, "Method Not Allowed", None).await;
        return Outcome::Ignored;
    }
    let outcome = evaluate(query, expected);
    let page = match &outcome {
        Outcome::Done(Ok(_)) => SUCCESS_PAGE,
        Outcome::Done(Err(NanoError::SignInCancelled)) => CANCELLED_PAGE,
        Outcome::Done(Err(_)) | Outcome::Ignored => FAILURE_PAGE,
    };
    let status = if matches!(outcome, Outcome::Ignored) {
        400
    } else {
        200
    };
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let _ = respond(&mut stream, status, reason, Some(page)).await;
    outcome
}

/// Decides a `/callback` query.
fn evaluate(query: &str, expected: &Expected) -> Outcome {
    let mut state = None;
    let mut code = None;
    let mut error = None;
    let mut issuer = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let slot = match key.as_ref() {
            "state" => &mut state,
            "code" => &mut code,
            "error" => &mut error,
            "iss" => &mut issuer,
            _ => continue,
        };
        if slot.is_some() {
            // A repeated parameter is ambiguous; refuse the request.
            return Outcome::Ignored;
        }
        *slot = Some(value.into_owned());
    }
    let state_ok = state.is_some_and(|state| expected.state.ct_eq_bytes(state.as_bytes()));
    if !state_ok {
        return Outcome::Ignored;
    }
    // RFC 9207: the server names itself in every authorization response,
    // success or error. A missing or different `iss` may come from another
    // authorization server (mix-up), so the sign-in fails either way.
    if issuer.is_none_or(|issuer| issuer.trim_end_matches('/') != expected.issuer) {
        return Outcome::Done(Err(NanoError::SignInFailed));
    }
    if let Some(error) = error {
        return Outcome::Done(Err(if error == "access_denied" {
            NanoError::SignInCancelled
        } else {
            NanoError::SignInFailed
        }));
    }
    match code.filter(|code| !code.is_empty()) {
        Some(code) => Outcome::Done(Ok(AuthorizationCode(SecretString::new(code)))),
        None => Outcome::Done(Err(NanoError::SignInFailed)),
    }
}

/// Reads up to the end of the request head, or `None` past [`MAX_REQUEST_HEAD`].
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            buffer.truncate(end);
            return String::from_utf8(buffer).ok();
        }
        if buffer.len() > MAX_REQUEST_HEAD {
            return None;
        }
    }
}

/// A fixed, self-contained page: no external resource, no reflected input.
async fn respond(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    message: Option<&str>,
) -> std::io::Result<()> {
    let body = match message {
        Some(message) => format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Nano Desktop</title>\
             <style>body{{font:16px system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem}}</style>\
             </head><body><p>{message}</p></body></html>"
        ),
        None => String::new(),
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;

    const ISSUER: &str = "https://nanoagents.ru";
    /// `iss=https://nanoagents.ru`, form-encoded.
    const ISS: &str = "iss=https%3A%2F%2Fnanoagents.ru";

    fn state() -> SecretString {
        SecretString::new("expected-state".to_owned())
    }

    async fn get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.expect("read");
        answer
    }

    async fn run(
        targets: Vec<&'static str>,
    ) -> (Result<AuthorizationCode, NanoError>, Vec<String>) {
        let listener = CallbackListener::bind().await.expect("bind");
        let port = listener.port();
        assert_eq!(
            listener.redirect_uri(),
            format!("http://127.0.0.1:{port}/callback")
        );
        let expected = state();
        let client = tokio::spawn(async move {
            let mut answers = Vec::new();
            for target in targets {
                answers.push(get(port, target).await);
            }
            answers
        });
        let result = listener
            .wait(&expected, ISSUER, Duration::from_secs(10), pending::<()>())
            .await;
        (result, client.await.expect("client"))
    }

    #[tokio::test]
    async fn returns_the_code_after_ignoring_noise() {
        let (result, answers) = run(vec![
            "/favicon.ico",
            "/callback?code=evil&state=wrong",
            "/callback?code=good-code&state=expected-state&iss=https%3A%2F%2Fnanoagents.ru",
        ])
        .await;
        assert_eq!(result.expect("code").0.expose(), "good-code");
        assert!(answers[0].starts_with("HTTP/1.1 404"));
        assert!(answers[1].starts_with("HTTP/1.1 400"));
        assert!(answers[2].starts_with("HTTP/1.1 200"));
        assert!(answers[2].contains(SUCCESS_PAGE));
        assert!(!answers[2].contains("good-code"));
        assert!(!answers[2].contains("<script"));
        assert!(!answers[2].contains("http://") && !answers[2].contains("https://"));
    }

    #[tokio::test]
    async fn access_denied_is_cancelled() {
        let (result, answers) = run(vec![
            "/callback?error=access_denied&state=expected-state&iss=https%3A%2F%2Fnanoagents.ru",
        ])
        .await;
        assert_eq!(result.expect_err("cancelled"), NanoError::SignInCancelled);
        assert!(answers[0].contains(CANCELLED_PAGE));
    }

    #[tokio::test]
    async fn a_missing_issuer_fails_success_and_error_responses() {
        for target in [
            "/callback?code=c&state=expected-state",
            "/callback?error=access_denied&state=expected-state",
            "/callback?code=c&state=expected-state&iss=",
        ] {
            let (result, answers) = run(vec![target]).await;
            assert_eq!(
                result.expect_err(target),
                NanoError::SignInFailed,
                "{target}"
            );
            assert!(answers[0].contains(FAILURE_PAGE), "{target}");
        }
    }

    #[tokio::test]
    async fn issuer_mismatch_fails() {
        let (result, _) = run(vec![
            "/callback?code=c&state=expected-state&iss=https%3A%2F%2Fevil.example",
        ])
        .await;
        assert_eq!(result.expect_err("mismatch"), NanoError::SignInFailed);
    }

    #[tokio::test]
    async fn repeated_state_is_refused() {
        let (result, answers) = run(vec![
            "/callback?code=a&state=expected-state&state=expected-state&iss=https%3A%2F%2Fnanoagents.ru",
            "/callback?code=b&state=expected-state&iss=https%3A%2F%2Fnanoagents.ru",
        ])
        .await;
        assert!(answers[0].starts_with("HTTP/1.1 400"));
        assert_eq!(result.expect("code").0.expose(), "b");
    }

    #[tokio::test]
    async fn oversize_head_is_refused_and_waiting_continues() {
        let listener = CallbackListener::bind().await.expect("bind");
        let port = listener.port();
        let expected = state();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port))
                .await
                .expect("connect");
            // Exactly one byte over the cap, so the listener consumes all of
            // it before answering (no reset from unread data).
            let prefix = "GET /callback?x=";
            let huge = format!(
                "{prefix}{}",
                "a".repeat(MAX_REQUEST_HEAD + 1 - prefix.len())
            );
            let _ = stream.write_all(huge.as_bytes()).await;
            let mut answer = String::new();
            let _ = stream.read_to_string(&mut answer).await;
            let ok = get(
                port,
                &format!("/callback?code=c&state=expected-state&{ISS}"),
            )
            .await;
            (answer, ok)
        });
        let result = listener
            .wait(&expected, ISSUER, Duration::from_secs(10), pending::<()>())
            .await;
        let (answer, ok) = client.await.expect("client");
        assert!(answer.starts_with("HTTP/1.1 431"));
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn times_out_and_cancels() {
        let listener = CallbackListener::bind().await.expect("bind");
        let result = listener
            .wait(&state(), ISSUER, Duration::from_millis(50), pending::<()>())
            .await;
        assert_eq!(result.expect_err("timeout"), NanoError::SignInTimeout);

        let listener = CallbackListener::bind().await.expect("bind");
        let result = listener
            .wait(
                &state(),
                ISSUER,
                Duration::from_secs(10),
                std::future::ready(()),
            )
            .await;
        assert_eq!(result.expect_err("cancel"), NanoError::SignInCancelled);
    }
}
