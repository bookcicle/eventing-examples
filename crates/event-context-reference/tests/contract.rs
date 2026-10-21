use eventing_contract::context_types::{AdmissionDecision, ContextPluginOutput};
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn invoke(bytes: &[u8]) -> ContextPluginOutput {
    let mut child = Command::new(env!("CARGO_BIN_EXE_event-context"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    assert!(result.stderr.is_empty());
    let output: ContextPluginOutput = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(output.contract_version, "2");
    output
}
#[test]
fn transforms_properties_without_claiming_identity_or_mutating_producer_fields() {
    let mut input: Value = serde_json::from_str(include_str!(
        "../../../examples/context/fixtures/anonymous.request.json"
    ))
    .unwrap();
    input["events"][0]["properties"] =
        json!({"path":"/checkout","email":"synthetic@example.com","phone":"test"});
    let output = invoke(&serde_json::to_vec(&input).unwrap());
    assert!(matches!(output.decision, AdmissionDecision::Accept));
    assert!(output.authentication.is_none());
    assert_eq!(output.event_mutations.len(), 1);
    let mutation = &output.event_mutations[0];
    assert_eq!(mutation.index, 0);
    assert!(mutation.name.is_none() && mutation.context.is_none());
    assert_eq!(
        mutation.properties.as_ref().unwrap(),
        json!({"path":"/checkout","processed_by":"context-demo-v1"})
            .as_object()
            .unwrap()
    );
    assert_eq!(output.request_context["application"], "example");
}
#[test]
fn malformed_old_contract_and_incomplete_batches_return_context_rejection() {
    let input: Value = serde_json::from_str(include_str!(
        "../../../examples/context/fixtures/anonymous.request.json"
    ))
    .unwrap();
    let mut bad = Vec::new();
    bad.push(b"{".to_vec());
    bad.push(vec![b' '; 2 * 1024 * 1024 + 1]);
    for field in ["schema_version", "batch_id", "events"] {
        let mut x = input.clone();
        x.as_object_mut().unwrap().remove(field);
        bad.push(serde_json::to_vec(&x).unwrap());
    }
    for version in ["1", "999"] {
        let mut x = input.clone();
        x["contract_version"] = json!(version);
        bad.push(serde_json::to_vec(&x).unwrap());
    }
    let mut x = input;
    x["batch"]["count"] = json!(2);
    bad.push(serde_json::to_vec(&x).unwrap());
    for bytes in bad {
        let result = invoke(&bytes);
        assert!(matches!(result.decision, AdmissionDecision::Reject));
        assert!(result.authentication.is_none() && result.event_mutations.is_empty());
    }
}
