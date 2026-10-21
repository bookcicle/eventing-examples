use event_auth_jwt::{reject_context, Verifier};
use eventing_contract::context_types::ContextPluginInput;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
const MAX_CONTEXT_INPUT_BYTES: u64 = 2 * 1024 * 1024;
fn main() {
    let result = (|| {
        let mut bytes = Vec::new();
        io::stdin()
            .take(MAX_CONTEXT_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_CONTEXT_INPUT_BYTES {
            return None;
        }
        let input: ContextPluginInput = serde_json::from_slice(&bytes).ok()?;
        let path = std::env::var_os("EVENT_CONTEXT_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/event-context/config.json"));
        Some(Verifier::load(&path).ok()?.evaluate_context(&input))
    })()
    .unwrap_or_else(reject_context);
    // Only version 2 contract JSON goes to stdout, including every error path.
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let _ = io::stdout().write_all(&bytes);
    }
}
