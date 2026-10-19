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
    let mut input: AuthPluginInput = serde_json::from_str(include_str!(
        "../../../examples/auth/fixtures/anonymous.request.json"
    ))
    .unwrap();
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

#[test]
fn executable_honors_config_and_fails_closed_on_bad_input() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let directory = std::env::temp_dir().join(format!(
        "eventing-jwt-test-{}-{}",
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
    let good = serde_json::to_vec(&input(Some(&token(&claims(), "test-key")))).unwrap();
    for (body, decision) in [
        (good, AuthDecision::Authenticated),
        (b"{".to_vec(), AuthDecision::Deny),
        (vec![b' '; 256 * 1024 + 1], AuthDecision::Deny),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_event-auth-jwt"))
            .env("EVENT_AUTH_CONFIG", &config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&body).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let result: eventing_contract::auth_contract::AuthPluginOutput =
            serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result.decision, decision);
    }
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
