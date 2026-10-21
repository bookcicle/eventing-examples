#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CoarseGeo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const AUTH_CONTRACT_VERSION: &str = "1";
pub const MAX_AUTH_STDOUT_BYTES: usize = 64 * 1024;
pub const MAX_AUTH_CONTEXT_KEYS: usize = 16;
pub const MAX_AUTH_CONTEXT_VALUE_BYTES: usize = 1024;

pub const DEFAULT_ALLOWED_CONTEXT_KEYS: &[&str] = &[
    "subject",
    "tenant",
    "email",
    "employee_id",
    "roles",
    "department",
    "org_id",
    "session_id",
    "rate_limit_tier",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthDecision {
    Anonymous,
    Authenticated,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthPluginBatchSummary {
    pub count: usize,
    pub event_names: Vec<String>,
    pub requested_namespaces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EphemeralClientMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geo: Option<CoarseGeo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthPluginInput {
    pub contract_version: String,
    pub request_id: String,
    pub path: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookie_header: Option<String>,
    pub batch: AuthPluginBatchSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<EphemeralClientMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthPluginOutput {
    pub contract_version: String,
    pub decision: AuthDecision,
    #[serde(default)]
    pub context: Map<String, Value>,
    #[serde(default)]
    pub allowed_namespaces: Option<Vec<String>>,
}
