//! Offline verification against an operator-pinned issuer, audience and public JWKS.
use eventing_contract::auth_contract::{
    AuthDecision, AuthPluginInput, AuthPluginOutput, AUTH_CONTRACT_VERSION,
};
use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet, KeyAlgorithm, KeyOperations, PublicKeyUse};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Map};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub issuer: String,
    pub audience: String,
    pub jwks_file: String,
    pub anonymous_namespaces: Vec<String>,
    pub tenant_namespaces: BTreeMap<String, Vec<String>>,
}
#[derive(Clone, Deserialize)]
struct Claims {
    sub: String,
    tenant: String,
}

pub struct Verifier {
    config: Config,
    keys: JwkSet,
}
fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn valid_namespaces(values: &[String]) -> bool {
    !values.is_empty()
        && values.len() <= eventing_contract::namespace::MAX_ALLOWED_NAMESPACES
        && values
            .iter()
            .all(|value| eventing_contract::namespace::is_valid_namespace_label(value))
}
pub fn deny() -> AuthPluginOutput {
    AuthPluginOutput {
        contract_version: AUTH_CONTRACT_VERSION.into(),
        decision: AuthDecision::Deny,
        context: Map::new(),
        allowed_namespaces: None,
    }
}
impl Verifier {
    pub fn load(path: &Path) -> Result<Self, &'static str> {
        let config_bytes = fs::read(path).map_err(|_| "config unreadable")?;
        if config_bytes.len() > 64 * 1024 {
            return Err("config too large");
        }
        let config: Config = serde_json::from_slice(&config_bytes).map_err(|_| "invalid config")?;
        let keys_path = path
            .parent()
            .unwrap_or(Path::new("."))
            .join(&config.jwks_file);
        let bytes = fs::read(keys_path).map_err(|_| "JWKS unreadable")?;
        if bytes.len() > 256 * 1024 {
            return Err("JWKS too large");
        }
        let keys: JwkSet = serde_json::from_slice(&bytes).map_err(|_| "invalid JWKS")?;
        Self::new(config, keys)
    }
    pub fn new(config: Config, keys: JwkSet) -> Result<Self, &'static str> {
        if !config.issuer.starts_with("https://")
            || !valid_text(&config.issuer)
            || !valid_text(&config.audience)
            || (!config.anonymous_namespaces.is_empty()
                && !valid_namespaces(&config.anonymous_namespaces))
            || config.tenant_namespaces.is_empty()
            || config
                .tenant_namespaces
                .iter()
                .any(|(tenant, values)| !valid_text(tenant) || !valid_namespaces(values))
            || keys.keys.is_empty()
            || keys.keys.len() > 32
        {
            return Err("invalid policy");
        }
        Ok(Self { config, keys })
    }
    pub fn evaluate(&self, input: &AuthPluginInput) -> AuthPluginOutput {
        self.authenticate(input).unwrap_or_else(deny)
    }
    fn authenticate(&self, input: &AuthPluginInput) -> Option<AuthPluginOutput> {
        if input.contract_version != AUTH_CONTRACT_VERSION {
            return None;
        }
        let credentials: Vec<_> = input
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("x-event-auth"))
            .collect();
        if credentials.is_empty() {
            if self.config.anonymous_namespaces.is_empty() {
                return None;
            }
            return Some(AuthPluginOutput {
                contract_version: AUTH_CONTRACT_VERSION.into(),
                decision: AuthDecision::Anonymous,
                context: Map::new(),
                allowed_namespaces: Some(self.config.anonymous_namespaces.clone()),
            });
        }
        if credentials.len() != 1 {
            return None;
        }
        let credential = credentials[0].1;
        let mut parts = credential.split_whitespace();
        if !parts.next()?.eq_ignore_ascii_case("Bearer") {
            return None;
        }
        let token = parts.next()?;
        if parts.next().is_some() || token.len() > 16 * 1024 {
            return None;
        }
        let header = decode_header(token).ok()?;
        if header.alg != Algorithm::RS256 {
            return None;
        }
        let kid = header.kid.as_deref()?;
        let matches: Vec<_> = self
            .keys
            .keys
            .iter()
            .filter(|key| key.common.key_id.as_deref() == Some(kid))
            .collect();
        if matches.len() != 1 {
            return None;
        }
        let key = matches[0];
        if !matches!(key.algorithm, AlgorithmParameters::RSA(_))
            || key
                .common
                .public_key_use
                .as_ref()
                .is_some_and(|usage| *usage != PublicKeyUse::Signature)
            || key
                .common
                .key_operations
                .as_ref()
                .is_some_and(|ops| !ops.contains(&KeyOperations::Verify))
            || key
                .common
                .key_algorithm
                .as_ref()
                .is_some_and(|alg| *alg != KeyAlgorithm::RS256)
        {
            return None;
        }
        let key = DecodingKey::from_jwk(key).ok()?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.audience]);
        validation.validate_nbf = true;
        validation.leeway = 30;
        let claims = decode::<Claims>(token, &key, &validation).ok()?.claims;
        if !valid_text(&claims.sub) || !valid_text(&claims.tenant) {
            return None;
        }
        let namespaces = self.config.tenant_namespaces.get(&claims.tenant)?.clone();
        let mut context = Map::new();
        context.insert("subject".into(), json!(claims.sub));
        context.insert("tenant".into(), json!(claims.tenant));
        Some(AuthPluginOutput {
            contract_version: AUTH_CONTRACT_VERSION.into(),
            decision: AuthDecision::Authenticated,
            context,
            allowed_namespaces: Some(namespaces),
        })
    }
}
