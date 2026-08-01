//! DTLS-PSK transport for the Philips Hue Entertainment streaming API.
//!
//! This crate exists for one reason: no pure-Python option can talk to a Hue
//! bridge's entertainment endpoint. pyOpenSSL exposes DTLS but has no PSK API,
//! and python-mbedtls stopped shipping wheels at cp312 built against mbedtls
//! 2.28. The system OpenSSL does support the required cipher suite, so we reach
//! it from Rust and hand Python a three-method object.
//!
//! Everything else in BrightBulb is Python; keep this module small.

use std::io::{self, Read, Write};
use std::net::{ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

use openssl::error::ErrorStack;
use openssl::ssl::{ErrorCode, Ssl, SslContext, SslMethod, SslStream, SslVerifyMode};
use pyo3::exceptions::{PyConnectionError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;

/// The only cipher suite a Hue bridge will negotiate.
///
/// `@SECLEVEL=0` is not optional: OpenSSL 3.x rejects all PSK suites at its
/// default security level, and the resulting handshake failure reports only
/// "no ciphers available", which looks like a network fault.
pub const HUE_CIPHER_LIST: &str = "PSK-AES128-GCM-SHA256:@SECLEVEL=0";

/// UDP port the bridge listens on for DTLS handshake and streaming.
pub const HUE_STREAM_PORT: u16 = 2100;

/// Entertainment packets are small (a 20-channel frame is 192 bytes), so cap the
/// DTLS record size well under any path MTU rather than risk IP fragmentation of
/// datagrams sent 50 times a second.
const DTLS_MTU: u32 = 1200;

/// The bridge issues a 16-byte PSK, hex-encoded as 32 characters.
const PSK_LEN: usize = 16;

fn ssl_err(e: ErrorStack) -> PyErr {
    PyRuntimeError::new_err(format!("openssl: {e}"))
}

/// Adapts a *connected* UDP socket to the `Read`/`Write` pair `SslStream` needs.
///
/// `std::net::UdpSocket` deliberately implements neither, since datagram
/// semantics are not stream semantics. That is fine here: DTLS maps one record
/// onto one datagram, so a single `send`/`recv` per call is exactly right.
struct UdpTransport(UdpSocket);

impl Read for UdpTransport {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.recv(buf)
    }
}

impl Write for UdpTransport {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.send(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A live DTLS-PSK connection to a Hue bridge's entertainment endpoint.
#[pyclass(module = "brightbulb_dtls")]
pub struct HueStream {
    stream: Option<SslStream<UdpTransport>>,
    peer: String,
}

#[pymethods]
impl HueStream {
    /// Open a DTLS-PSK connection to `host`.
    ///
    /// `identity` is the bridge application key; `psk_hex` is the 32-character
    /// hex `clientkey` issued at pairing time. Both come from the same
    /// registration call and only work together.
    #[new]
    #[pyo3(signature = (host, identity, psk_hex, port=HUE_STREAM_PORT, timeout=10.0, retries=2))]
    fn new(
        py: Python<'_>,
        host: &str,
        identity: &str,
        psk_hex: &str,
        port: u16,
        timeout: f64,
        retries: u32,
    ) -> PyResult<Self> {
        let psk = decode_hex(psk_hex)?;
        if psk.len() != PSK_LEN {
            return Err(PyValueError::new_err(format!(
                "clientkey must be {PSK_LEN} bytes ({} hex chars), got {}",
                PSK_LEN * 2,
                psk.len()
            )));
        }
        if identity.is_empty() {
            return Err(PyValueError::new_err(
                "identity (app key) must not be empty",
            ));
        }

        let peer = format!("{host}:{port}");
        let addr = peer
            .to_socket_addrs()
            .map_err(|e| PyConnectionError::new_err(format!("cannot resolve {peer}: {e}")))?
            .next()
            .ok_or_else(|| PyConnectionError::new_err(format!("no address for {peer}")))?;

        let identity = identity.to_owned();
        // `timeout` budgets the whole handshake. Individual reads use a much
        // shorter slice so the loop can notice the budget running out.
        let overall = Duration::from_secs_f64(timeout.max(0.5));
        let read_timeout = Duration::from_millis(250).min(overall);

        // The handshake blocks on network I/O; holding the GIL through it would
        // freeze the UI for as long as the bridge takes to answer.
        let stream = py.detach(move || {
            let mut last: Option<String> = None;

            // Each attempt already polls patiently for its whole budget, so a
            // retry here is not about slow responses -- it recovers from a hard
            // failure such as the bridge still tearing down a previous stream.
            for attempt in 0..retries.max(1) {
                match handshake(addr, &identity, &psk, read_timeout, overall) {
                    Ok(stream) => return Ok(stream),
                    Err(err) => {
                        last = Some(err);
                        if attempt + 1 < retries.max(1) {
                            std::thread::sleep(Duration::from_millis(300));
                        }
                    }
                }
            }
            Err(last.unwrap_or_else(|| "handshake failed".to_owned()))
        });

        match stream {
            Ok(stream) => Ok(Self {
                stream: Some(stream),
                peer,
            }),
            Err(message) => Err(PyConnectionError::new_err(format!(
                "DTLS handshake with {peer} failed: {message}. \
                 Check that the entertainment configuration was started and that \
                 no other app is streaming to this bridge."
            ))),
        }
    }

    /// Send one entertainment frame as a single datagram.
    fn send(&mut self, py: Python<'_>, payload: &[u8]) -> PyResult<()> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("stream is closed"))?;

        py.detach(|| stream.write_all(payload))
            .map_err(|e| PyConnectionError::new_err(format!("send failed: {e}")))
    }

    /// Shut the connection down. Safe to call more than once.
    fn close(&mut self, py: Python<'_>) -> PyResult<()> {
        if let Some(mut stream) = self.stream.take() {
            // Best effort: the bridge drops the session on its own timeout, and
            // a failed shutdown must not mask the real reason we are closing.
            py.detach(|| stream.shutdown()).ok();
        }
        Ok(())
    }

    #[getter]
    fn closed(&self) -> bool {
        self.stream.is_none()
    }

    #[getter]
    fn peer(&self) -> &str {
        &self.peer
    }

    fn __enter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __exit__(
        &mut self,
        py: Python<'_>,
        _exc_type: &Bound<'_, PyAny>,
        _exc_value: &Bound<'_, PyAny>,
        _traceback: &Bound<'_, PyAny>,
    ) -> PyResult<bool> {
        self.close(py)?;
        Ok(false)
    }

    fn __repr__(&self) -> String {
        let state = if self.stream.is_some() {
            "open"
        } else {
            "closed"
        };
        format!("<HueStream {} {}>", self.peer, state)
    }
}

fn handshake(
    addr: std::net::SocketAddr,
    identity: &str,
    psk: &[u8],
    read_timeout: Duration,
    overall: Duration,
) -> Result<SslStream<UdpTransport>, String> {
    let socket = UdpSocket::bind(if addr.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .map_err(|e| format!("cannot open UDP socket: {e}"))?;
    socket
        .connect(addr)
        .map_err(|e| format!("cannot connect to {addr}: {e}"))?;
    // Without a read timeout a silent bridge would block the caller forever.
    socket
        .set_read_timeout(Some(read_timeout))
        .map_err(|e| format!("cannot set read timeout: {e}"))?;
    socket
        .set_write_timeout(Some(read_timeout))
        .map_err(|e| format!("cannot set write timeout: {e}"))?;

    let mut builder =
        SslContext::builder(SslMethod::dtls_client()).map_err(|e| format!("ssl context: {e}"))?;
    builder
        .set_cipher_list(HUE_CIPHER_LIST)
        .map_err(|e| format!("cipher list rejected: {e}"))?;
    // PSK authenticates both ends; there is no certificate to verify, and the
    // bridge presents none.
    builder.set_verify(SslVerifyMode::NONE);

    let psk = psk.to_vec();
    let identity = identity.to_owned();
    builder.set_psk_client_callback(move |_ssl, _hint, identity_out, psk_out| {
        // The identity buffer must hold a NUL-terminated string.
        if identity.len() + 1 > identity_out.len() || psk.len() > psk_out.len() {
            return Ok(0);
        }
        identity_out[..identity.len()].copy_from_slice(identity.as_bytes());
        identity_out[identity.len()] = 0;
        psk_out[..psk.len()].copy_from_slice(&psk);
        Ok(psk.len())
    });

    let context = builder.build();
    let mut ssl = Ssl::new(&context).map_err(|e| format!("ssl: {e}"))?;
    ssl.set_mtu(DTLS_MTU).map_err(|e| format!("mtu: {e}"))?;

    let mut stream =
        SslStream::new(ssl, UdpTransport(socket)).map_err(|e| format!("ssl stream: {e}"))?;

    // A DTLS handshake is several round trips, and a Hue bridge can take well
    // over a second to answer one of them. The socket read timeout is therefore
    // *not* a failure signal -- it only means "nothing has arrived yet". Treating
    // it as fatal (or as a reason to restart the handshake from scratch) makes
    // connecting fail outright unless the per-read timeout happens to exceed the
    // bridge's slowest step. Poll instead, and bound the whole handshake.
    let deadline = Instant::now() + overall;
    loop {
        match stream.connect() {
            Ok(()) => return Ok(stream),
            Err(err) => {
                let waiting = matches!(err.code(), ErrorCode::WANT_READ | ErrorCode::WANT_WRITE);
                if !waiting {
                    return Err(format!("{err}"));
                }
                if Instant::now() >= deadline {
                    return Err(format!("no response within {:.1}s", overall.as_secs_f64()));
                }
            }
        }
    }
}

fn decode_hex(value: &str) -> PyResult<Vec<u8>> {
    let cleaned: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    if !cleaned.len().is_multiple_of(2) {
        return Err(PyValueError::new_err(
            "clientkey has an odd number of hex digits",
        ));
    }
    (0..cleaned.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&cleaned[i..i + 2], 16)
                .map_err(|_| PyValueError::new_err("clientkey is not valid hexadecimal"))
        })
        .collect()
}

/// Version string of the OpenSSL this module linked against.
#[pyfunction]
fn openssl_version() -> String {
    openssl::version::version().to_string()
}

/// Verify the linked OpenSSL will accept Hue's PSK cipher suite for DTLS.
///
/// Cheap smoke test for the failure mode that costs the most time to diagnose:
/// a build linked against an OpenSSL whose PSK suites are compiled out or
/// blocked by the security level.
#[pyfunction]
fn probe_psk_support() -> PyResult<bool> {
    let mut builder = SslContext::builder(SslMethod::dtls()).map_err(ssl_err)?;
    builder.set_cipher_list(HUE_CIPHER_LIST).map_err(ssl_err)?;
    builder.set_verify(SslVerifyMode::NONE);
    Ok(true)
}

#[pymodule]
fn brightbulb_dtls(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("HUE_CIPHER_LIST", HUE_CIPHER_LIST)?;
    m.add("HUE_STREAM_PORT", HUE_STREAM_PORT)?;
    m.add_class::<HueStream>()?;
    m.add_function(wrap_pyfunction!(openssl_version, m)?)?;
    m.add_function(wrap_pyfunction!(probe_psk_support, m)?)?;
    Ok(())
}
