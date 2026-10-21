//! Anonymous transformation starter implementing the Context Layer contract.
use eventing_contract::context_types::{
    AdmissionDecision, ContextPluginInput, ContextPluginOutput, EventMutation,
    CONTEXT_CONTRACT_VERSION,
};
use serde_json::{json, Map};
use std::io::{self, Read, Write};
fn reject() -> ContextPluginOutput {
    ContextPluginOutput {
        contract_version: CONTEXT_CONTRACT_VERSION.into(),
        decision: AdmissionDecision::Reject,
        authentication: None,
        request_context: Map::new(),
        event_mutations: Vec::new(),
    }
}
fn main() {
    let result = (|| {
        let mut bytes = Vec::new();
        io::stdin()
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 2 * 1024 * 1024 {
            return None;
        }
        let input: ContextPluginInput = serde_json::from_slice(&bytes).ok()?;
        if input.request.contract_version != CONTEXT_CONTRACT_VERSION
            || input.schema_version != "1"
            || input.events.is_empty()
            || input.request.batch.count != input.events.len()
        {
            return None;
        }
        let mutations = input
            .events
            .iter()
            .enumerate()
            .filter_map(|(index, event)| {
                let mut properties = event.get("properties")?.as_object()?.clone();
                // Example policy; nested redaction requires an application-specific schema.
                properties.remove("email");
                properties.remove("phone");
                properties.insert("processed_by".into(), json!("context-demo-v1"));
                Some(EventMutation {
                    index,
                    name: None,
                    properties: Some(properties),
                    context: None,
                })
            })
            .collect();
        let request_context =
            json!({"application":"example","transformation_version":"context-demo-v1"})
                .as_object()?
                .clone();
        Some(ContextPluginOutput {
            contract_version: CONTEXT_CONTRACT_VERSION.into(),
            decision: AdmissionDecision::Accept,
            authentication: None,
            request_context,
            event_mutations: mutations,
        })
    })()
    .unwrap_or_else(reject);
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let _ = io::stdout().write_all(&bytes);
    }
}
