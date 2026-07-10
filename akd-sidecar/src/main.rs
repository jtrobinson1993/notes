//! v8 key-transparency sidecar — serves the `akd` directory over a localhost API
//! the Node relay calls (spec/key-transparency.md). Bind is 127.0.0.1 only; the
//! relay authenticates with the shared `AKD_SIDECAR_TOKEN` bearer.
use std::sync::Arc;

use akd_sidecar::{router, KtDirectory};
use tokio::sync::Mutex;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("AKD_SIDECAR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8091);
    let token = std::env::var("AKD_SIDECAR_TOKEN").ok().filter(|t| !t.is_empty());
    if token.is_none() {
        eprintln!("WARNING: AKD_SIDECAR_TOKEN unset — the KT sidecar API is unauthenticated");
    }

    let data_dir = std::env::var("AKD_SIDECAR_DATA").unwrap_or_else(|_| "./akd-data".into());
    let kt = Arc::new(Mutex::new(
        KtDirectory::open(&data_dir).await.expect("initialise akd directory"),
    ));
    eprintln!("akd-sidecar state dir: {data_dir}");
    let app = router(kt, token);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind sidecar port");
    eprintln!("akd-sidecar listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
}
