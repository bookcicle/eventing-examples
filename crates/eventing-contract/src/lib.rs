//! Context Layer request metadata and version 2 wire types; no ingestion implementation.
pub mod auth_contract;
pub mod context_types;
pub mod namespace {
    pub const MAX_ALLOWED_NAMESPACES: usize = 32;
    pub fn is_valid_namespace_label(label: &str) -> bool {
        let mut bytes = label.bytes();
        !label.is_empty() && label.len() <= 64
            && bytes.next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    }
}
