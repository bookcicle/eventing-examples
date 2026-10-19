use reqwest::{blocking::Client, redirect::Policy, Url};
use sha2::{Digest, Sha256};
use std::{env, error::Error, thread::sleep, time::Duration};
use uuid::Uuid;
fn run() -> Result<(), Box<dyn Error>> {
    let endpoint = Url::parse(&env::var("EVENTING_ENDPOINT").map_err(|_| {
        "Set EVENTING_ENDPOINT to the public URL, including /events, /public or /secure"
    })?)?;
    let local = endpoint.scheme() == "http"
        && matches!(
            endpoint.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]")
        );
    if (endpoint.scheme() != "https" && !local)
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !matches!(endpoint.path(), "/events" | "/public" | "/secure")
    {
        return Err("Invalid public Eventing endpoint".into());
    }
    let mut batch: serde_json::Value = serde_json::from_str(include_str!("../../batch.json"))?;
    batch["batch_id"] = Uuid::new_v4().to_string().into();
    for event in batch["events"]
        .as_array_mut()
        .ok_or("Missing fixture events")?
    {
        event["event_id"] = Uuid::new_v4().to_string().into();
        event["event_time"] = chrono::Utc::now().to_rfc3339().into();
        event["context"]["namespace"] = env::var("EVENTING_NAMESPACE")
            .unwrap_or_else(|_| "general".into())
            .into();
        event["properties"]["runtime"] = "rust".into();
    }
    let body = serde_json::to_vec(&batch)?;
    let hash = format!("{:x}", Sha256::digest(&body));
    let token = env::var("EVENTING_AUTH_TOKEN").ok();
    if token
        .as_ref()
        .is_some_and(|v| v.chars().any(char::is_control))
    {
        return Err("Invalid token characters".into());
    }
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()?;
    for attempt in 0..3 {
        let mut request = client
            .post(endpoint.clone())
            .header("Content-Type", "application/json")
            .header("x-amz-content-sha256", &hash)
            .body(body.clone());
        if let Some(token) = token.as_ref().filter(|v| !v.is_empty()) {
            request = request.header("x-event-auth", format!("Bearer {token}"));
        }
        let status = request.send().map(|r| r.status().as_u16()).unwrap_or(503);
        if status == 202 {
            println!("Accepted 2 events by the ingestion pipeline (S3 delivery is asynchronous).");
            return Ok(());
        }
        if !matches!(status, 429 | 500 | 502 | 503 | 504) || attempt == 2 {
            return Err(format!("Eventing request failed: HTTP {status}").into());
        }
        // Reuse the exact body and IDs. Server-side deduplication is not promised.
        sleep(Duration::from_millis(250 * 2_u64.pow(attempt)));
    }
    Err("Retry limit reached".into())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
