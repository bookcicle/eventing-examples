use event_auth_jwt::{Config, Verifier};
use eventing_contract::auth_contract::{AuthDecision, AuthPluginInput};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
fn keys() -> JwkSet {
    serde_json::from_str(include_str!("fixtures/jwks.json")).unwrap()
}
fn verifier(keys: JwkSet) -> Verifier {
    let config: Config =
        serde_json::from_str(include_str!("../../../examples/jwt/config.example.json")).unwrap();
    Verifier::new(config, keys).unwrap()
}
fn input(token: Option<&str>) -> AuthPluginInput {
    let context: eventing_contract::context_types::ContextPluginInput = serde_json::from_str(
        include_str!("../../../examples/context/fixtures/anonymous.request.json"),
    )
    .unwrap();
    let mut input = context.request;
    input.contract_version = eventing_contract::auth_contract::AUTH_CONTRACT_VERSION.into();
    if let Some(token) = token {
        input
            .headers
            .insert("x-event-auth".into(), format!("Bearer {token}"));
    }
    input
}
fn claims() -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    json!({"iss":"https://identity.example.com/","aud":"https://events.example.com","exp":now+300,"nbf":now-1,"sub":"test-user","tenant":"claims","allowed_namespaces":["security"]})
}
fn token(claims: &Value, kid: &str) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.into());
    encode(
        &header,
        claims,
        &EncodingKey::from_rsa_der(include_bytes!("fixtures/TEST-ONLY-private.der")),
    )
    .unwrap()
}
#[test]
fn authenticated_context_and_namespaces_come_from_verified_policy() {
    let output = verifier(keys()).evaluate(&input(Some(&token(&claims(), "test-key"))));
    assert_eq!(output.decision, AuthDecision::Authenticated);
    assert_eq!(
        output.context,
        json!({"subject":"test-user","tenant":"claims"})
            .as_object()
            .unwrap()
            .clone()
    );
    assert_eq!(output.allowed_namespaces.unwrap(), ["general", "claims"]);
}
#[test]
fn no_credential_can_be_anonymous_but_malformed_credentials_cannot() {
    let verifier = verifier(keys());
    assert_eq!(
        verifier.evaluate(&input(None)).decision,
        AuthDecision::Anonymous
    );
    for value in ["", "garbage", "Bearer", "Basic invalid", "Bearer one two"] {
        let mut request = input(None);
        request.headers.insert("x-event-auth".into(), value.into());
        assert_eq!(verifier.evaluate(&request).decision, AuthDecision::Deny);
    }
}
#[test]
fn invalid_claims_are_denied() {
    let verifier = verifier(keys());
    for (name, value) in [
        ("iss", json!("https://attacker.example/")),
        ("aud", json!("other-app")),
        ("exp", json!(1)),
        ("nbf", json!(4102444800_u64)),
        ("tenant", json!("unknown")),
        ("sub", json!("")),
    ] {
        let mut claims = claims();
        claims[name] = value;
        assert_eq!(
            verifier
                .evaluate(&input(Some(&token(&claims, "test-key"))))
                .decision,
            AuthDecision::Deny,
            "{name}"
        );
    }
    for name in ["exp", "iss", "aud", "sub", "tenant"] {
        let mut claims = claims();
        claims.as_object_mut().unwrap().remove(name);
        assert_eq!(
            verifier
                .evaluate(&input(Some(&token(&claims, "test-key"))))
                .decision,
            AuthDecision::Deny,
            "missing {name}"
        );
    }
}
#[test]
fn wrong_key_signature_algorithm_and_ambiguous_kid_are_denied() {
    assert_eq!(
        verifier(keys())
            .evaluate(&input(Some(&token(&claims(), "unknown"))))
            .decision,
        AuthDecision::Deny
    );
    let mut duplicate = keys();
    duplicate.keys.push(duplicate.keys[0].clone());
    assert_eq!(
        verifier(duplicate)
            .evaluate(&input(Some(&token(&claims(), "test-key"))))
            .decision,
        AuthDecision::Deny
    );
    let mut token_bytes = token(&claims(), "test-key").into_bytes();
    let pos = token_bytes.iter().rposition(|b| *b == b'.').unwrap() + 5;
    token_bytes[pos] = if token_bytes[pos] == b'A' { b'B' } else { b'A' };
    assert_eq!(
        verifier(keys())
            .evaluate(&input(Some(std::str::from_utf8(&token_bytes).unwrap())))
            .decision,
        AuthDecision::Deny
    );
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some("test-key".into());
    let bad = encode(
        &header,
        &claims(),
        &EncodingKey::from_secret(b"not-a-public-key"),
    )
    .unwrap();
    assert_eq!(
        verifier(keys()).evaluate(&input(Some(&bad))).decision,
        AuthDecision::Deny
    );
}
#[test]
fn disabled_anonymous_and_bad_config_fail_closed() {
    let mut config: Config =
        serde_json::from_str(include_str!("../../../examples/jwt/config.example.json")).unwrap();
    config.anonymous_namespaces.clear();
    let verifier = Verifier::new(config, keys()).unwrap();
    assert_eq!(verifier.evaluate(&input(None)).decision, AuthDecision::Deny);
    assert!(Verifier::load(std::path::Path::new("missing-config.json")).is_err());
}

fn context_input(credential: Option<&str>) -> Value {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../examples/context/fixtures/anonymous.request.json"
    ))
    .unwrap();
    if let Some(token) = credential {
        value["headers"] = json!({"x-event-auth":format!("Bearer {token}")});
    }
    value
}

#[test]
fn executable_uses_context_contract_on_success_and_every_rejection() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let directory = std::env::temp_dir().join(format!(
        "eventing-context-jwt-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let config = directory.join("config.json");
    std::fs::write(
        &config,
        include_str!("../../../examples/jwt/config.example.json"),
    )
    .unwrap();
    std::fs::write(
        directory.join("jwks.json"),
        include_str!("fixtures/jwks.json"),
    )
    .unwrap();
    let mut signed_claims = claims();
    signed_claims["sid"] = json!("verified-session");
    signed_claims["rate_limit_tier"] = json!("pro");
    let valid_token = token(&signed_claims, "test-key");
    let mut cases: Vec<(Vec<u8>, Option<AuthDecision>)> = vec![
        (
            serde_json::to_vec(&context_input(Some(&valid_token))).unwrap(),
            Some(AuthDecision::Authenticated),
        ),
        (
            serde_json::to_vec(&context_input(None)).unwrap(),
            Some(AuthDecision::Anonymous),
        ),
        (
            serde_json::to_vec(&context_input(Some("invalid"))).unwrap(),
            None,
        ),
        (b"{".to_vec(), None),
        (vec![b' '; 2 * 1024 * 1024 + 1], None),
    ];
    for field in ["schema_version", "batch_id", "events"] {
        let mut invalid = context_input(Some(&valid_token));
        invalid.as_object_mut().unwrap().remove(field);
        cases.push((serde_json::to_vec(&invalid).unwrap(), None));
    }
    for version in ["1", "999"] {
        let mut invalid = context_input(Some(&valid_token));
        invalid["contract_version"] = json!(version);
        cases.push((serde_json::to_vec(&invalid).unwrap(), None));
    }
    let mut mismatch = context_input(Some(&valid_token));
    mismatch["batch"]["count"] = json!(2);
    cases.push((serde_json::to_vec(&mismatch).unwrap(), None));
    let mut large = context_input(Some(&valid_token));
    large["events"][0]["properties"] = json!({"large":"x".repeat(128*1024),"tenant":"forged", "subject":"forged","rate_limit_tier":"forged"});
    cases.push((
        serde_json::to_vec(&large).unwrap(),
        Some(AuthDecision::Authenticated),
    ));
    for (body, expected) in cases {
        let mut child = Command::new(env!("CARGO_BIN_EXE_event-auth-jwt"))
            .env("EVENT_CONTEXT_CONFIG", &config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&body).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let result: eventing_contract::context_types::ContextPluginOutput =
            serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result.contract_version, "2");
        assert!(result.request_context.is_empty() && result.event_mutations.is_empty());
        match expected {
            Some(decision) => {
                assert!(matches!(
                    result.decision,
                    eventing_contract::context_types::AdmissionDecision::Accept
                ));
                let auth = result.authentication.unwrap();
                assert_eq!(auth.decision, decision);
                if decision == AuthDecision::Authenticated {
                    assert_eq!(auth.context,json!({"subject":"test-user","tenant":"claims","session_id":"verified-session","rate_limit_tier":"pro"}).as_object().unwrap().clone());
                    assert_eq!(auth.allowed_namespaces.unwrap(), ["general", "claims"]);
                } else {
                    assert!(auth.context.is_empty());
                    assert_eq!(auth.allowed_namespaces.unwrap(), ["general"]);
                }
            }
            None => {
                assert!(matches!(
                    result.decision,
                    eventing_contract::context_types::AdmissionDecision::Reject
                ));
                assert!(result.authentication.is_none());
            }
        }
    }
    let output = Command::new(env!("CARGO_BIN_EXE_event-auth-jwt"))
        .env("EVENT_CONTEXT_CONFIG", directory.join("missing.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap()
        .wait_with_output()
        .unwrap();
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["contract_version"], "2");
    assert_eq!(result["decision"], "reject");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_namespace_configuration_is_rejected_using_runtime_rules() {
    for namespace in ["Claims", "_claims", "claims/private", ""] {
        let mut config: Config =
            serde_json::from_str(include_str!("../../../examples/jwt/config.example.json"))
                .unwrap();
        config
            .tenant_namespaces
            .insert("claims".into(), vec![namespace.into()]);
        assert!(Verifier::new(config, keys()).is_err());
    }
}

#[test]
fn verified_session_and_tier_claims_are_forwarded_and_validated() {
    let mut claims = claims();
    claims["sid"] = json!("server-session");
    claims["rate_limit_tier"] = json!("pro");
    let output = verifier(keys()).evaluate(&input(Some(&token(&claims, "test-key"))));
    assert_eq!(output.decision, AuthDecision::Authenticated);
    assert_eq!(output.context["session_id"], "server-session");
    assert_eq!(output.context["rate_limit_tier"], "pro");
    for field in ["sid", "rate_limit_tier"] {
        let mut bad = claims.clone();
        bad[field] = json!("");
        assert_eq!(
            verifier(keys())
                .evaluate(&input(Some(&token(&bad, "test-key"))))
                .decision,
            AuthDecision::Deny
        );
    }
}
