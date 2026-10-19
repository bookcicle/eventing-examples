use eventing_contract::auth_contract::{
    AuthDecision, AuthPluginInput, AuthPluginOutput, AUTH_CONTRACT_VERSION,
};
use serde_json::{json, Map};
use std::io::{self, Read, Write};

fn main() {
    let mut input_bytes = Vec::new();
    if io::stdin()
        .take(256 * 1024 + 1)
        .read_to_end(&mut input_bytes)
        .is_err()
    {
        write_deny();
        return;
    }

    let Ok(input) = serde_json::from_slice::<AuthPluginInput>(&input_bytes) else {
        write_deny();
        return;
    };

    if input_bytes.len() > 256 * 1024 || input.contract_version != AUTH_CONTRACT_VERSION {
        write_deny();
        return;
    }

    let credentials: Vec<_> = input
        .headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("x-event-auth"))
        .collect();
    if credentials.len() > 1 {
        write_deny();
        return;
    }
    let auth_header = credentials.first().map(|(_, value)| value.trim());

    // Reference policy:
    // 1. No credential -> anonymous (only allowed for the 'general' namespace)
    // 2. Valid Bearer token -> authenticated with subject, tenant, email, and allowed_namespaces
    // 3. Any unrecognized or malformed credential -> deny (never silently downgrade to anonymous)
    if auth_header.is_none() {
        let out = AuthPluginOutput {
            contract_version: AUTH_CONTRACT_VERSION.to_string(),
            decision: AuthDecision::Anonymous,
            context: Map::new(),
            allowed_namespaces: Some(vec!["general".to_string()]),
        };
        write_output(&out);
        return;
    }

    if let Some(token) = auth_header
        .unwrap_or("")
        .strip_prefix("Bearer ")
        .map(str::trim)
    {
        if token == "valid-claims-token" {
            let mut ctx = Map::new();
            ctx.insert("subject".to_string(), json!("employee_123"));
            ctx.insert("tenant".to_string(), json!("claims"));
            ctx.insert("email".to_string(), json!("adjuster@customer.example"));
            let out = AuthPluginOutput {
                contract_version: AUTH_CONTRACT_VERSION.to_string(),
                decision: AuthDecision::Authenticated,
                context: ctx,
                allowed_namespaces: Some(vec!["general".to_string(), "claims".to_string()]),
            };
            write_output(&out);
            return;
        } else if token == "valid-security-token" {
            let mut ctx = Map::new();
            ctx.insert("subject".to_string(), json!("secops_01"));
            ctx.insert("tenant".to_string(), json!("security"));
            let out = AuthPluginOutput {
                contract_version: AUTH_CONTRACT_VERSION.to_string(),
                decision: AuthDecision::Authenticated,
                context: ctx,
                allowed_namespaces: Some(vec![
                    "general".to_string(),
                    "security".to_string(),
                    "claims".to_string(),
                ]),
            };
            write_output(&out);
            return;
        }
    }

    // Invalid credential presented -> strictly deny
    write_deny();
}

fn write_deny() {
    let out = AuthPluginOutput {
        contract_version: AUTH_CONTRACT_VERSION.to_string(),
        decision: AuthDecision::Deny,
        context: Map::new(),
        allowed_namespaces: None,
    };
    write_output(&out);
}

fn write_output(out: &AuthPluginOutput) {
    if let Ok(bytes) = serde_json::to_vec(out) {
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(&bytes);
        let _ = stdout.flush();
    }
}
