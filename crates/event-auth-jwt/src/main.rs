use event_auth_jwt::{deny, Verifier};
use eventing_contract::auth_contract::AuthPluginInput;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
fn main() {
    let result = (|| {
        let mut bytes = Vec::new();
        io::stdin()
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 256 * 1024 {
            return None;
        }
        let input: AuthPluginInput = serde_json::from_slice(&bytes).ok()?;
        let path = std::env::var_os("EVENT_AUTH_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/event-auth/config.json"));
        Some(Verifier::load(&path).ok()?.evaluate(&input))
    })()
    .unwrap_or_else(deny);
    // Only contract JSON goes to stdout. Never log tokens, raw requests or claims.
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let _ = io::stdout().write_all(&bytes);
    }
}
