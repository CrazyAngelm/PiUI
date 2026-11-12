//! Host-owned Sign in with ChatGPT for locally hosted, open-source clients.
//!
//! OpenAI's public OAuth and model endpoints are fixed here. Native Pi keeps
//! owning inference serialization, tools and session history.

use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::{Url, form_urlencoded::Serializer};
use zeroize::Zeroizing;

use crate::loopback::{CHATGPT_REDIRECT_PATH, CallbackListener};
use crate::net::{API_TIMEOUT, MAX_API_BODY, MAX_ERROR_BODY, base_builder, read_capped};
use crate::pkce::{PkcePair, random_bytes, random_token};
use crate::{NanoError, OpenBrowser, SecretString};

mod session;
pub(crate) use session::ChatGptGrant;
pub use session::{CHATGPT_CONNECTION_ID, CHATGPT_PROVIDER_ID, ChatGptStatus, ChatGptSubscription};

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE: &str = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS: &str = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE: &str = "https://api.openai.com/v1";
const MODELS: &str = "https://api.openai.com/v1/models";
pub(crate) const RESPONSES: &str = "https://api.openai.com/v1/responses";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ChatGptError {
    #[error("ChatGPT sign-in failed")]
    SignIn,
    #[error("ChatGPT sign-in was cancelled")]
    Cancelled,
    #[error("ChatGPT sign-in timed out")]
    Timeout,
    #[error("the system browser could not be opened")]
    Browser,
    #[error("ChatGPT is unavailable")]
    Offline,
    #[error("ChatGPT plan usage was not granted")]
    NoPlanPermission,
    #[error("ChatGPT authorization has expired or been revoked")]
    Reauthenticate,
    #[error("ChatGPT settings could not be saved or read")]
    Storage,
    #[error("the ChatGPT credential store is unavailable")]
    CredentialStore,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Registration {
    pub(crate) client_id: String,
    pub(crate) subject: String,
    pub(crate) email: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptModel {
    pub id: String,
    pub name: String,
}

pub(crate) struct ChatGptTokens {
    pub(crate) access: SecretString,
    pub(crate) refresh: SecretString,
    pub(crate) expires_in: Duration,
}

pub(crate) fn client() -> Result<reqwest::Client, ChatGptError> {
    base_builder()
        .map_err(|_| ChatGptError::Offline)?
        .https_only(true)
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|_| ChatGptError::Offline)
}

pub(crate) fn new_host_id() -> Result<String, ChatGptError> {
    let mut random = random_bytes::<16>().map_err(|_| ChatGptError::Storage)?;
    // RFC 9562 UUIDv4, which OpenAI accepts as a stable host URN.
    random[6] = (random[6] & 0x0f) | 0x40;
    random[8] = (random[8] & 0x3f) | 0x80;
    let id = u128::from_be_bytes(random);
    Ok(format!(
        "urn:uuid:{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        id >> 96,
        (id >> 80) & 0xffff,
        (id >> 64) & 0xffff,
        (id >> 48) & 0xffff,
        id & 0xffffffffffff,
    ))
}

pub(crate) async fn authorize<SaveIssued>(
    http: &reqwest::Client,
    host_id: &str,
    saved: Option<&Registration>,
    retry_client: Option<&str>,
    open: OpenBrowser,
    cancel: impl Future<Output = ()> + Send,
    save_issued: impl FnOnce(String) -> SaveIssued,
) -> Result<(Registration, ChatGptTokens), ChatGptError>
where
    SaveIssued: Future<Output = Result<(), ChatGptError>> + Send,
{
    let known_client = saved.map(|r| r.client_id.as_str()).or(retry_client);
    let listener = CallbackListener::bind()
        .await
        .map_err(|_| ChatGptError::SignIn)?;
    let redirect = listener.redirect_uri_for(CHATGPT_REDIRECT_PATH);
    let pkce = PkcePair::generate().map_err(|_| ChatGptError::SignIn)?;
    let state = random_token().map_err(|_| ChatGptError::SignIn)?;
    let nonce = random_token().map_err(|_| ChatGptError::SignIn)?;
    let mut url = Url::parse(AUTHORIZE).map_err(|_| ChatGptError::SignIn)?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", known_client.unwrap_or(DYNAMIC_CLIENT))
            .append_pair("ext_agent_host_id", host_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", state.expose())
            .append_pair("nonce", nonce.expose())
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &pkce.challenge);
        if known_client.is_none() {
            query.append_pair("agent_name_hint", "Nano Desktop");
        }
    }
    tokio::task::spawn_blocking(move || open(&url))
        .await
        .map_err(|_| ChatGptError::Browser)?
        .map_err(|()| ChatGptError::Browser)?;
    let (code, callback_client) = listener
        .wait_for_chatgpt(&state, ISSUER, cancel)
        .await
        .map_err(|error| match error {
            NanoError::SignInCancelled => ChatGptError::Cancelled,
            NanoError::SignInTimeout => ChatGptError::Timeout,
            _ => ChatGptError::SignIn,
        })?;
    let client_id = issued_client(known_client, callback_client)?;
    if known_client.is_none() {
        save_issued(client_id.clone()).await?;
    }
    let mut wire = token_request(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &client_id),
            ("code", code.0.expose()),
            ("code_verifier", pkce.verifier.expose()),
            ("redirect_uri", &redirect),
            ("resource", RESOURCE),
        ],
    )
    .await?;
    let issued_refresh = wire.refresh_token.clone();
    let verified = async {
        let id_token = wire.id_token.take().ok_or(ChatGptError::SignIn)?;
        let identity = verify_identity(http, &id_token, &client_id, &nonce).await?;
        if saved.is_some_and(|prior| prior.subject != identity.sub) {
            return Err(ChatGptError::SignIn);
        }
        Ok((identity, wire.into_tokens(None, true)?))
    }
    .await;
    match verified {
        Ok((identity, tokens)) => Ok((
            Registration {
                client_id,
                subject: identity.sub,
                email: identity.email,
            },
            tokens,
        )),
        Err(error) => {
            if let Some(token) = issued_refresh {
                let _ = revoke(http, &client_id, &token).await;
            }
            Err(error)
        }
    }
}

fn issued_client(saved: Option<&str>, callback: Option<String>) -> Result<String, ChatGptError> {
    match (saved, callback) {
        (Some(saved), callback) if callback.as_deref().is_none_or(|id| id == saved) => {
            Ok(saved.to_owned())
        }
        (None, Some(id)) if valid_client_id(&id) => Ok(id),
        _ => Err(ChatGptError::SignIn),
    }
}

pub(crate) fn valid_client_id(id: &str) -> bool {
    id.starts_with("oaiapp_")
        && id.len() > "oaiapp_".len()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub(crate) async fn refresh(
    http: &reqwest::Client,
    registration: &Registration,
    refresh_token: &SecretString,
) -> Result<ChatGptTokens, ChatGptError> {
    token_request(
        http,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &registration.client_id),
            ("refresh_token", refresh_token.expose()),
            ("resource", RESOURCE),
        ],
    )
    .await?
    .into_tokens(Some(refresh_token), false)
}

pub(crate) async fn revoke(http: &reqwest::Client, client_id: &str, token: &SecretString) -> bool {
    post_form(
        http,
        REVOKE,
        &[
            ("token", token.expose()),
            ("token_type_hint", "refresh_token"),
            ("client_id", client_id),
        ],
    )
    .await
    .is_ok_and(|response| response.status().is_success())
}

#[derive(Deserialize)]
struct WireTokens {
    #[serde(deserialize_with = "deserialize_secret")]
    access_token: SecretString,
    #[serde(default, deserialize_with = "deserialize_optional_secret")]
    refresh_token: Option<SecretString>,
    #[serde(default, deserialize_with = "deserialize_optional_secret")]
    id_token: Option<SecretString>,
    expires_in: u64,
    scope: Option<String>,
    token_type: String,
}

fn deserialize_secret<'de, D: serde::Deserializer<'de>>(d: D) -> Result<SecretString, D::Error> {
    String::deserialize(d).map(SecretString::new)
}

fn deserialize_optional_secret<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<SecretString>, D::Error> {
    Option::<String>::deserialize(d).map(|value| value.map(SecretString::new))
}

impl WireTokens {
    fn into_tokens(
        self,
        prior_refresh: Option<&SecretString>,
        require_scope: bool,
    ) -> Result<ChatGptTokens, ChatGptError> {
        if !self.scope.as_deref().map_or(!require_scope, |scope| {
            scope
                .split_ascii_whitespace()
                .any(|item| item == DIRECT_SCOPE)
        }) {
            return Err(ChatGptError::NoPlanPermission);
        }
        let refresh = self
            .refresh_token
            .or_else(|| prior_refresh.cloned())
            .ok_or(ChatGptError::SignIn)?;
        if !self.token_type.eq_ignore_ascii_case("Bearer")
            || self.expires_in == 0
            || !valid_bearer(&self.access_token)
            || !valid_bearer(&refresh)
        {
            return Err(ChatGptError::SignIn);
        }
        Ok(ChatGptTokens {
            access: self.access_token,
            refresh,
            expires_in: Duration::from_secs(self.expires_in),
        })
    }
}

fn valid_bearer(token: &SecretString) -> bool {
    !token.is_empty() && token.expose().bytes().all(|byte| byte.is_ascii_graphic())
}

async fn post_form(
    http: &reqwest::Client,
    url: &str,
    pairs: &[(&str, &str)],
) -> Result<reqwest::Response, ChatGptError> {
    let form = {
        let mut encoder = Serializer::new(String::new());
        encoder.extend_pairs(pairs.iter().copied());
        Zeroizing::new(encoder.finish())
    };
    http.post(url)
        .header(
            http::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form.to_string())
        .send()
        .await
        .map_err(|_| ChatGptError::Offline)
}

async fn token_request(
    http: &reqwest::Client,
    pairs: &[(&str, &str)],
) -> Result<WireTokens, ChatGptError> {
    let mut response = post_form(http, TOKEN, pairs).await?;
    if response.status().is_server_error() {
        return Err(ChatGptError::Offline);
    }
    if !response.status().is_success() {
        #[derive(Deserialize)]
        struct Failure {
            error: TokenFailureCode,
        }
        let rejected = read_json::<Failure>(&mut response, MAX_ERROR_BODY)
            .await
            .is_ok_and(|reply| reply.error.needs_sign_in());
        return Err(if rejected {
            ChatGptError::Reauthenticate
        } else {
            ChatGptError::SignIn
        });
    }
    read_json(&mut response, MAX_API_BODY).await
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TokenFailureCode {
    Plain(String),
    Detailed { code: String },
}

impl TokenFailureCode {
    fn needs_sign_in(&self) -> bool {
        let code = match self {
            Self::Plain(code) | Self::Detailed { code } => code.as_str(),
        };
        matches!(
            code,
            "invalid_grant"
                | "invalid_refresh_token"
                | "token_expired"
                | "refresh_token_expired"
                | "refresh_token_invalidated"
                | "refresh_token_reused"
        )
    }
}

async fn read_json<T: DeserializeOwned>(
    response: &mut reqwest::Response,
    cap: usize,
) -> Result<T, ChatGptError> {
    let bytes = Zeroizing::new(
        read_capped(response, cap)
            .await
            .map_err(|_| ChatGptError::Offline)?,
    );
    serde_json::from_slice(&bytes).map_err(|_| ChatGptError::SignIn)
}

pub(crate) async fn models(
    http: &reqwest::Client,
    token: &SecretString,
) -> Result<Vec<ChatGptModel>, ChatGptError> {
    #[derive(Deserialize)]
    struct ModelList {
        models: Vec<WireModel>,
    }
    #[derive(Deserialize)]
    struct WireModel {
        slug: String,
        display_name: String,
        visibility: String,
    }
    let mut response = http
        .get(MODELS)
        .bearer_auth(token.expose())
        .send()
        .await
        .map_err(|_| ChatGptError::Offline)?;
    if !response.status().is_success() {
        return Err(if response.status() == http::StatusCode::UNAUTHORIZED {
            ChatGptError::Reauthenticate
        } else {
            ChatGptError::Offline
        });
    }
    let list: ModelList = read_json(&mut response, MAX_API_BODY).await?;
    Ok(list
        .models
        .into_iter()
        .filter(|model| {
            model.visibility == "list"
                && !model.slug.is_empty()
                && !model.slug.chars().any(char::is_control)
                && !model.display_name.is_empty()
                && !model.display_name.chars().any(char::is_control)
        })
        .map(|model| ChatGptModel {
            id: model.slug,
            name: model.display_name,
        })
        .collect())
}

#[derive(Deserialize)]
struct KeySet {
    keys: Vec<RsaKey>,
}

#[derive(Deserialize)]
struct RsaKey {
    kid: String,
    kty: String,
    alg: Option<String>,
    n: String,
    e: String,
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
    kid: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    Single(String),
    List(Vec<String>),
}

#[derive(Deserialize)]
struct Identity {
    iss: String,
    sub: String,
    aud: Audience,
    azp: Option<String>,
    exp: u64,
    nonce: String,
    email: Option<String>,
}

async fn verify_identity(
    http: &reqwest::Client,
    token: &SecretString,
    client_id: &str,
    nonce: &SecretString,
) -> Result<Identity, ChatGptError> {
    let mut response = http
        .get(JWKS)
        .send()
        .await
        .map_err(|_| ChatGptError::Offline)?;
    if !response.status().is_success() {
        return Err(ChatGptError::Offline);
    }
    let keys = read_json(&mut response, MAX_API_BODY).await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ChatGptError::SignIn)?
        .as_secs();
    decode_identity(token, &keys, client_id, nonce, now)
}

fn decode_identity(
    token: &SecretString,
    keys: &KeySet,
    client_id: &str,
    nonce: &SecretString,
    now: u64,
) -> Result<Identity, ChatGptError> {
    let (signed, signature) = token
        .expose()
        .rsplit_once('.')
        .ok_or(ChatGptError::SignIn)?;
    let (header, claims) = signed.split_once('.').ok_or(ChatGptError::SignIn)?;
    let header: JwtHeader =
        serde_json::from_slice(&decode(header)?).map_err(|_| ChatGptError::SignIn)?;
    if header.alg != "RS256" {
        return Err(ChatGptError::SignIn);
    }
    let key = keys
        .keys
        .iter()
        .find(|key| {
            key.kid == header.kid
                && key.kty == "RSA"
                && key.alg.as_deref().is_none_or(|alg| alg == "RS256")
        })
        .ok_or(ChatGptError::SignIn)?;
    ring::signature::RsaPublicKeyComponents {
        n: decode(&key.n)?,
        e: decode(&key.e)?,
    }
    .verify(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        signed.as_bytes(),
        &decode(signature)?,
    )
    .map_err(|_| ChatGptError::SignIn)?;
    let claims = Zeroizing::new(decode(claims)?);
    let identity: Identity = serde_json::from_slice(&claims).map_err(|_| ChatGptError::SignIn)?;
    let audience_matches = match &identity.aud {
        Audience::Single(aud) => aud == client_id,
        Audience::List(aud) => {
            aud.iter().any(|aud| aud == client_id)
                && (aud.len() == 1 || identity.azp.as_deref() == Some(client_id))
        }
    };
    if identity.iss != ISSUER
        || !audience_matches
        || identity.azp.as_deref().is_some_and(|azp| azp != client_id)
        || identity.sub.is_empty()
        || identity.exp <= now
        || !nonce.ct_eq_bytes(identity.nonce.as_bytes())
    {
        return Err(ChatGptError::SignIn);
    }
    Ok(identity)
}

fn decode(value: &str) -> Result<Vec<u8>, ChatGptError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ChatGptError::SignIn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_identity_binds_signature_audience_nonce_and_expiry() {
        // Signed once with a disposable 2048-bit RSA test key. The private
        // key is absent and all claims describe a synthetic account.
        let keys = KeySet { keys: vec![RsaKey {
            kid: "fixture-key".to_owned(), kty: "RSA".to_owned(), alg: Some("RS256".to_owned()),
            n: "qtd-JLaCNUrq-2lRk0kYyVo_XNRKRtejrMoTP10rhIGx0p7fs5fe5fhHuaeG_gQoWIx-fkn4FOuJLZITOEs4OiJ4ibFcQ8rOHLnF80BATzrHJDWFHFA_ToZh5iY8ns9keKbuTw73ZUymyTmJsi6PrFL1Z0S-SN6hmYXwEDRyr0Hvi-5sAhBQjNxz8nHQNotzJnoB85wvBvgpQY0ffac5eG4MxlcFCbLDgYOONoo1u_jaCzKs9hl5fY5nhT7OcQHeUI9XobYOjpwcz-0tx_LqSnXY5yhzNPsfWXVoQgFwAjpPqKaZ4HcfxYDC83sB7NJEu-QIE252zdVmsHUxwxfy8w".to_owned(),
            e: "AQAB".to_owned(),
        }] };
        let token = SecretString::new("eyJhbGciOiJSUzI1NiIsImtpZCI6ImZpeHR1cmUta2V5In0.eyJpc3MiOiJodHRwczovL2F1dGgub3BlbmFpLmNvbSIsInN1YiI6ImZpeHR1cmUtc3ViamVjdCIsImF1ZCI6Im9haWFwcF9maXh0dXJlIiwiZXhwIjoyMDAwLCJub25jZSI6ImZpeHR1cmUtbm9uY2UiLCJlbWFpbCI6ImZpeHR1cmVAZXhhbXBsZS50ZXN0In0.UbbcU7VPDqPav6cE1Tn6a37HMljtLE7iTxy2_ZYdquSXoIuuxesVR7FMr9Qes-fVR3DSinAGU9GWOoA6oKCAn1PAabnXblv9JYCxQR-hNnXq_0QwISVu68Ss8E7g66oMZQOxxdi_Frjf9fxqM4xCFZWO5V6XMH4emBx9umCZ3IgvwJXaK9dUyVJ6y0j-1POGXEXySoxY-qROj1qfsr6Das4MJR_5Pfh_skFwFuGj4P5PNcbM-Bub49uFDvmT86kjbZT0NJa5Tn6HOxfr9aJ-pbtApaFqXanaQHwpob_41x6Nqd3jNckgDfqt2PdhLdfpBN4y74tjsdKgImhlZbLopw".to_owned());
        let nonce = SecretString::new("fixture-nonce".to_owned());
        let identity =
            decode_identity(&token, &keys, "oaiapp_fixture", &nonce, 1000).expect("verified");
        assert_eq!(identity.sub, "fixture-subject");
        assert_eq!(identity.email.as_deref(), Some("fixture@example.test"));
        let wrong_nonce = SecretString::new("other-nonce".to_owned());
        assert!(decode_identity(&token, &keys, "oaiapp_fixture", &wrong_nonce, 1000).is_err());
        assert!(decode_identity(&token, &keys, "oaiapp_other", &nonce, 1000).is_err());
        assert!(decode_identity(&token, &keys, "oaiapp_fixture", &nonce, 2000).is_err());
        let mut bad = token.expose().to_owned();
        let start = bad.rfind('.').expect("signature") + 1;
        bad.replace_range(start..start + 1, "A");
        assert!(
            decode_identity(
                &SecretString::new(bad),
                &keys,
                "oaiapp_fixture",
                &nonce,
                1000
            )
            .is_err()
        );
    }

    #[test]
    fn a_returning_registration_never_adopts_another_client_id() {
        let registration = Registration {
            client_id: "oaiapp_existing".to_owned(),
            subject: "existing-user".to_owned(),
            email: None,
        };
        assert_eq!(
            issued_client(Some(&registration.client_id), None),
            Ok(registration.client_id.clone())
        );
        assert!(
            issued_client(
                Some(&registration.client_id),
                Some("oaiapp_other".to_owned())
            )
            .is_err()
        );
        assert!(issued_client(None, Some(DYNAMIC_CLIENT.to_owned())).is_err());
        assert!(issued_client(None, None).is_err());
        assert!(issued_client(None, Some("oaiapp_new".to_owned())).is_ok());
    }

    #[test]
    fn documented_refresh_rejections_require_sign_in_again() {
        for code in [
            "invalid_grant",
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
        ] {
            for body in [serde_json::json!(code), serde_json::json!({ "code": code })] {
                assert!(
                    serde_json::from_value::<TokenFailureCode>(body)
                        .expect("error code")
                        .needs_sign_in()
                );
            }
        }
        assert!(!TokenFailureCode::Plain("invalid_client".to_owned()).needs_sign_in());
        assert!(!TokenFailureCode::Plain("temporarily_unavailable".to_owned()).needs_sign_in());
    }

    #[test]
    fn identity_grant_is_insufficient_and_refresh_may_keep_previous_scopes() {
        let wire = |scope: Option<&str>| WireTokens {
            access_token: SecretString::new("synthetic-access".to_owned()),
            refresh_token: None,
            id_token: None,
            expires_in: 60,
            scope: scope.map(str::to_owned),
            token_type: "Bearer".to_owned(),
        };
        let prior = SecretString::new("synthetic-refresh".to_owned());
        assert!(matches!(
            wire(Some("openid email")).into_tokens(Some(&prior), true),
            Err(ChatGptError::NoPlanPermission)
        ));
        assert!(wire(None).into_tokens(Some(&prior), false).is_ok());
        assert!(
            wire(Some(DIRECT_SCOPE))
                .into_tokens(Some(&prior), true)
                .is_ok()
        );
    }
}
