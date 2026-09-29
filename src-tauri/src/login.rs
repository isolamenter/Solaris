//! Native leg of the desktop authorization-code flow.
//!
//! This module owns exactly one thing: a loopback listener on a random free
//! port, and the single callback request it receives. The `state` and the S256
//! PKCE pair are minted in TypeScript and never travel to this side, so nothing
//! here can log or persist a verifier. The code that comes back is returned to
//! the caller as a raw request target and validated there.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Only this path is a valid callback (CONTRACTS §2.3 step 1).
pub const CALLBACK_PATH: &str = "/callback";
/// Loopback only. `localhost` and any other spelling is never a listener target.
pub const CALLBACK_HOST: &str = "127.0.0.1";
/// Longest request head accepted before the connection is dropped.
const MAX_REQUEST_BYTES: usize = 8 * 1024;
/// Poll interval of the accept loop, so cancellation is noticed promptly.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// A bound loopback listener, the port it got, and the way to stop it.
pub struct PendingLogin {
    listener: TcpListener,
    pub port: u16,
    pub stop: Arc<AtomicBool>,
    pub deadline: Instant,
}

/// What the callback leg can fail with.
#[derive(Debug)]
pub enum LoginError {
    Timeout,
    Cancelled,
    Unavailable,
    Io(std::io::Error),
}

impl std::fmt::Display for LoginError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoginError::Timeout => formatter.write_str("desktop login timed out"),
            LoginError::Cancelled => formatter.write_str("desktop login was cancelled"),
            LoginError::Unavailable => formatter.write_str("desktop login is no longer listening"),
            LoginError::Io(error) => write!(formatter, "desktop login listener failed: {error}"),
        }
    }
}

impl From<std::io::Error> for LoginError {
    fn from(error: std::io::Error) -> Self {
        LoginError::Io(error)
    }
}

/// Bind a loopback listener on a random free port.
pub fn bind_loopback(timeout: Duration) -> std::io::Result<PendingLogin> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    if port == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "the operating system returned port 0",
        ));
    }
    Ok(PendingLogin {
        listener,
        port,
        stop: Arc::new(AtomicBool::new(false)),
        deadline: Instant::now() + timeout,
    })
}

/// The exact redirect URI the Server must accept for this attempt.
pub fn redirect_uri(port: u16) -> String {
    format!("http://{CALLBACK_HOST}:{port}{CALLBACK_PATH}")
}

/// Second handle on the same socket, so the accept loop can own a clone while
/// the state keeps the original for cancellation.
pub fn cloned_listener(pending: &PendingLogin) -> std::io::Result<TcpListener> {
    pending.listener.try_clone()
}

/// Request target of the first request line, e.g. `/callback?code=...&state=...`.
///
/// Returns the raw target; the caller validates path and state. A request that
/// is not an HTTP GET with a readable target yields `None`.
pub fn parse_request_target(request_head: &str) -> Option<String> {
    let line = request_head.lines().next()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    let version = parts.next()?;
    if method != "GET" || !version.starts_with("HTTP/1.") {
        return None;
    }
    if !target.starts_with('/') || target.len() > 2048 {
        return None;
    }
    if target.bytes().any(|byte| !byte.is_ascii_graphic()) {
        return None;
    }
    Some(target.to_string())
}

/// Accept one request, answer it, and hand back its target.
///
/// The listener is dropped when this returns, so a timeout or a cancellation
/// closes the port rather than leaving it listening.
pub fn wait_for_target(
    listener: &TcpListener,
    stop: &AtomicBool,
    deadline: Instant,
) -> Result<String, LoginError> {
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(LoginError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(LoginError::Timeout);
        }
        match listener.accept() {
            Ok((stream, _peer)) => {
                // A BSD accept() inherits the listener's non-blocking flag, which
                // would make the request read fail immediately. Reads here are
                // blocking with a timeout instead.
                let _ = stream.set_nonblocking(false);
                let head = read_request_head(&stream)?;
                let target = parse_request_target(&head);
                let _ = write_response(&stream, target.is_some());
                return target.ok_or(LoginError::Unavailable);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(LoginError::Io(error)),
        }
    }
}

fn read_request_head(stream: &TcpStream) -> Result<String, LoginError> {
    let mut stream = stream;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        if buffer.len() >= MAX_REQUEST_BYTES {
            break;
        }
        let read = match stream.read(&mut chunk) {
            Ok(read) => read,
            // Defensive: a platform that still hands back a non-blocking stream.
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(LoginError::Io(error)),
        };
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.contains(&b'\n') {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn write_response(stream: &TcpStream, accepted: bool) -> std::io::Result<()> {
    let body = if accepted {
        "<!doctype html><meta charset=\"utf-8\"><title>Solaris</title><p>Authorization received. You can close this tab and return to Solaris.</p>"
    } else {
        "<!doctype html><meta charset=\"utf-8\"><title>Solaris</title><p>This callback was not understood. Return to Solaris and try again.</p>"
    };
    let status = if accepted { "200 OK" } else { "400 Bad Request" };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nPragma: no-cache\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = stream;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

/// Whether a URL may be handed to the system browser. Only http(s): an
/// authorization endpoint, never a local file or a custom scheme.
pub fn is_openable_url(value: &str) -> bool {
    (value.starts_with("http://") || value.starts_with("https://"))
        && value.len() <= 4096
        && value.bytes().all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
}

/// Open a validated URL in the system browser.
pub fn open_in_browser(url: &str) -> std::io::Result<()> {
    if !is_openable_url(url) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "only http and https URLs may be opened",
        ));
    }
    #[cfg(target_os = "macos")]
    let launched = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let launched = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let launched = std::process::Command::new("xdg-open").arg(url).spawn();
    launched.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream as ClientStream;

    fn connect_and_send(port: u16, request: &str) {
        let mut client = ClientStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        client.write_all(request.as_bytes()).expect("write");
        let _ = client.flush();
    }

    #[test]
    fn a_random_free_loopback_port_is_used() {
        let first = bind_loopback(Duration::from_secs(5)).expect("bind");
        let second = bind_loopback(Duration::from_secs(5)).expect("bind");
        assert_ne!(first.port, 0);
        assert_ne!(second.port, 0);
        assert_ne!(first.port, second.port);

        let uri = redirect_uri(first.port);
        assert_eq!(uri, format!("http://127.0.0.1:{}/callback", first.port));
        assert!(!uri.contains("localhost"));
    }

    #[test]
    fn the_callback_target_comes_back_verbatim() {
        let pending = bind_loopback(Duration::from_secs(5)).expect("bind");
        let listener = cloned_listener(&pending).expect("clone");
        let port = pending.port;

        let sender = std::thread::spawn(move || {
            connect_and_send(port, "GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        });
        let target = wait_for_target(&listener, &pending.stop, pending.deadline).expect("target");
        sender.join().expect("sender");

        assert_eq!(target, "/callback?code=abc123&state=xyz");
    }

    #[test]
    fn a_timeout_closes_the_listener() {
        let pending = bind_loopback(Duration::from_millis(80)).expect("bind");
        let listener = cloned_listener(&pending).expect("clone");
        let started = Instant::now();
        let error = wait_for_target(&listener, &pending.stop, pending.deadline).expect_err("timeout");
        assert!(matches!(error, LoginError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_cancellation_stops_the_loop() {
        let pending = bind_loopback(Duration::from_secs(30)).expect("bind");
        let listener = cloned_listener(&pending).expect("clone");
        let stop = Arc::clone(&pending.stop);
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            stop.store(true, Ordering::SeqCst);
        });
        let error = wait_for_target(&listener, &pending.stop, pending.deadline).expect_err("cancel");
        canceller.join().expect("canceller");
        assert!(matches!(error, LoginError::Cancelled));
    }

    #[test]
    fn request_targets_are_parsed_strictly() {
        assert_eq!(
            parse_request_target("GET /callback?code=a&state=b HTTP/1.1\r\nHost: x\r\n\r\n").as_deref(),
            Some("/callback?code=a&state=b")
        );
        assert!(parse_request_target("POST /callback HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_request_target("GET http://evil.example/ HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_request_target("GET /callback HTTP/2.0\r\n\r\n").is_none());
        assert!(parse_request_target("").is_none());
        assert!(parse_request_target("garbage").is_none());
    }

    #[test]
    fn only_http_urls_may_be_opened() {
        assert!(is_openable_url("http://127.0.0.1:3210/api/auth/desktop/authorize?x=1"));
        assert!(is_openable_url("https://solaris.example/api/auth/desktop/authorize"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("/relative"));
        assert!(!is_openable_url("https://example.com/\""));
    }
}
