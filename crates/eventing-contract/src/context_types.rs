//! Public version 2 Context Layer wire types, independent of ingestion internals.
use crate::auth_contract::{AuthDecision, AuthPluginInput};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const CONTEXT_CONTRACT_VERSION: &str = "2";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPluginInput {
    #[serde(flatten)]
    pub request: AuthPluginInput,
    pub schema_version: String,
    pub batch_id: String,
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionDecision {
    Accept,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextAuthentication {
    pub decision: AuthDecision,
    #[serde(default)]
    pub context: Map<String, Value>,
    pub allowed_namespaces: Option<Vec<String>>,
}

/// Each supplied field replaces that complete event field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventMutation {
    pub index: usize,
    pub name: Option<String>,
    pub properties: Option<Map<String, Value>>,
    pub context: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextPluginOutput {
    pub contract_version: String,
    pub decision: AdmissionDecision,
    pub authentication: Option<ContextAuthentication>,
    #[serde(default)]
    pub request_context: Map<String, Value>,
    #[serde(default)]
    pub event_mutations: Vec<EventMutation>,
}
