use super::broker::{
    ChildLaunch, HostFuture, LinksBroker, LinksHost, SessionInfo, first_prompt, message_prompt,
    report_prompt,
};
use super::model::*;
use super::store::{FileLinksStore, LinksStore, MemoryLinksStore};
use crate::workspace_api::TurnState;
use piui_runtime::workspace_runtime::{
    HarnessKind, PermissionMode, PromptMode, SessionStatus, TurnOutcome, WorkspaceModel,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Default)]
struct FakeData {
    sessions: HashMap<String, SessionInfo>,
    turns: HashMap<String, watch::Sender<TurnState>>,
    answers: HashMap<String, (String, String)>,
    launches: Vec<ChildLaunch>,
    sent: Vec<(String, String, PromptMode)>,
    unavailable: Vec<HarnessKind>,
    fail: Option<ErrorCode>,
    interrupted: Vec<String>,
}
#[derive(Clone, Default)]
struct FakeHost {
    data: Arc<Mutex<FakeData>>,
    auto: Arc<AtomicBool>,
    response: Arc<Mutex<String>>,
}
fn info(id: &str) -> SessionInfo {
    SessionInfo {
        id: id.into(),
        workspace_id: "workspace".into(),
        title: format!("Title {id}"),
        harness: HarnessKind::Codex,
        model: Some(WorkspaceModel {
            id: "parent-model".into(),
            name: "Parent model".into(),
            provider: Some("parent-provider".into()),
            thinking_levels: None,
        }),
        thinking_level: Some("high".into()),
        permission_mode: PermissionMode::FullAccess,
        network_access: true,
        state: LinkedChatState::Idle,
        allowed: true,
    }
}
fn status(state: LinkedChatState) -> SessionStatus {
    match state {
        LinkedChatState::Starting => SessionStatus::Starting,
        LinkedChatState::Running => SessionStatus::Running,
        LinkedChatState::Idle => SessionStatus::Idle,
        LinkedChatState::Failed => SessionStatus::Failed,
        LinkedChatState::Closed => SessionStatus::Closed,
    }
}
impl FakeHost {
    fn add(&self, info: SessionInfo) {
        let mut data = self.data.lock().expect("fake data");
        data.turns.insert(
            info.id.clone(),
            watch::channel(TurnState {
                generation: 0,
                status: status(info.state),
                outcome: None,
            })
            .0,
        );
        data.sessions.insert(info.id.clone(), info);
    }
    fn finish(&self, session_id: &str, text: &str, completed: u64) {
        let mut data = self.data.lock().expect("fake data");
        data.answers.insert(
            session_id.into(),
            (uuid::Uuid::new_v4().to_string(), text.into()),
        );
        data.sessions.get_mut(session_id).expect("session").state = LinkedChatState::Idle;
        let turns = data.turns.get(session_id).expect("turns");
        let previous = *turns.borrow();
        turns.send_replace(TurnState {
            generation: previous.generation + completed,
            status: SessionStatus::Idle,
            outcome: Some(TurnOutcome::Succeeded),
        });
    }
    fn sends(&self) -> Vec<(String, String, PromptMode)> {
        self.data.lock().expect("fake data").sent.clone()
    }
}
impl LinksHost for FakeHost {
    fn session(&self, session_id: &str) -> Result<SessionInfo, ErrorCode> {
        self.data
            .lock()
            .expect("fake data")
            .sessions
            .get(session_id)
            .cloned()
            .ok_or(ErrorCode::UnknownSession)
    }
    fn available(&self, harness: HarnessKind) -> bool {
        !self
            .data
            .lock()
            .expect("fake data")
            .unavailable
            .contains(&harness)
    }
    fn launch(&self, launch: ChildLaunch) -> HostFuture<Result<(), ErrorCode>> {
        let this = self.clone();
        Box::pin(async move {
            this.data
                .lock()
                .expect("fake data")
                .launches
                .push(launch.clone());
            this.add(SessionInfo {
                id: launch.session_id,
                workspace_id: launch.workspace_id,
                title: launch.title,
                harness: launch.harness,
                model: launch.model,
                thinking_level: launch.thinking_level,
                permission_mode: launch.permission_mode,
                network_access: launch.network_access,
                state: LinkedChatState::Idle,
                allowed: true,
            });
            Ok(())
        })
    }
    fn ensure_live(&self, session_id: String) -> HostFuture<Result<(), ErrorCode>> {
        let this = self.clone();
        Box::pin(async move {
            let mut data = this.data.lock().expect("fake data");
            if let Some(error) = data.fail {
                return Err(error);
            }
            let session = data
                .sessions
                .get_mut(&session_id)
                .ok_or(ErrorCode::UnknownSession)?;
            if session.state == LinkedChatState::Closed {
                session.state = LinkedChatState::Idle;
            }
            Ok(())
        })
    }
    fn turns(&self, session_id: &str) -> Result<watch::Receiver<TurnState>, ErrorCode> {
        self.data
            .lock()
            .expect("fake data")
            .turns
            .get(session_id)
            .map(watch::Sender::subscribe)
            .ok_or(ErrorCode::Unavailable)
    }
    fn send(
        &self,
        session_id: String,
        text: String,
        mode: PromptMode,
    ) -> HostFuture<Result<(), ErrorCode>> {
        let this = self.clone();
        Box::pin(async move {
            let prior = {
                let mut data = this.data.lock().expect("fake data");
                data.sent.push((session_id.clone(), text, mode));
                let session = data
                    .sessions
                    .get_mut(&session_id)
                    .ok_or(ErrorCode::UnknownSession)?;
                let prior = session.state;
                session.state = LinkedChatState::Running;
                let turns = data.turns.get(&session_id).expect("turns");
                let previous = *turns.borrow();
                turns.send_replace(TurnState {
                    status: SessionStatus::Running,
                    ..previous
                });
                prior
            };
            if this.auto.load(Ordering::Acquire) {
                let response = this.response.lock().expect("response").clone();
                this.finish(
                    &session_id,
                    &response,
                    if prior == LinkedChatState::Running && mode == PromptMode::FollowUp {
                        2
                    } else {
                        1
                    },
                );
            }
            Ok(())
        })
    }
    fn interrupt(&self, session_id: String) -> HostFuture<Result<(), ErrorCode>> {
        let this = self.clone();
        Box::pin(async move {
            this.data
                .lock()
                .expect("fake data")
                .interrupted
                .push(session_id);
            Ok(())
        })
    }
    fn close(&self, session_id: String) -> HostFuture<()> {
        let this = self.clone();
        Box::pin(async move {
            let mut data = this.data.lock().expect("fake data");
            data.sessions.get_mut(&session_id).expect("session").state = LinkedChatState::Closed;
            let turns = data.turns.get(&session_id).expect("turns");
            let previous = *turns.borrow();
            turns.send_replace(TurnState {
                status: SessionStatus::Closed,
                ..previous
            });
        })
    }
    fn last_answer(
        &self,
        session_id: String,
    ) -> HostFuture<Result<Option<(String, String)>, ErrorCode>> {
        let this = self.clone();
        Box::pin(async move {
            Ok(this
                .data
                .lock()
                .expect("fake data")
                .answers
                .get(&session_id)
                .cloned())
        })
    }
    fn answer(
        &self,
        session_id: String,
        block_id: String,
    ) -> HostFuture<Result<Option<String>, ErrorCode>> {
        let this = self.clone();
        Box::pin(async move {
            Ok(this
                .data
                .lock()
                .expect("fake data")
                .answers
                .get(&session_id)
                .filter(|(id, _)| *id == block_id)
                .map(|(_, text)| text.clone()))
        })
    }
}
fn setup() -> (LinksBroker, FakeHost, Arc<MemoryLinksStore>) {
    let host = FakeHost::default();
    host.add(info("parent"));
    host.add(info("other"));
    *host.response.lock().expect("response") = "A complete answer".into();
    let store = Arc::new(MemoryLinksStore::default());
    let broker = LinksBroker::new(Arc::new(host.clone()), store.clone(), true, true);
    (broker, host, store)
}
async fn call(broker: &LinksBroker, caller: &str, operation: Value) -> Value {
    broker
        .handle(caller, operation.as_object().expect("operation").clone())
        .await
}
async fn started(broker: &LinksBroker) -> String {
    let result = call(
        broker,
        "parent",
        json!({"op":"start","title":"Child","prompt":"Complete this work"}),
    )
    .await;
    assert_eq!(result["ok"], true, "{result}");
    result["sessionId"].as_str().expect("id").into()
}
async fn wait_for_send(host: &FakeHost, predicate: impl Fn(&(String, String, PromptMode)) -> bool) {
    while !host.sends().iter().any(&predicate) {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn session_links_start_inherits_same_harness_authority_and_native_context() {
    let (broker, host, _) = setup();
    host.data
        .lock()
        .expect("data")
        .sessions
        .get_mut("parent")
        .expect("parent")
        .permission_mode = PermissionMode::Native;
    let child = started(&broker).await;
    let launches = host.data.lock().expect("data").launches.clone();
    assert_eq!(launches.len(), 1);
    let launch = &launches[0];
    assert_eq!(launch.parent_session_id, "parent");
    assert_eq!(launch.session_id, child);
    assert_eq!(launch.harness, HarnessKind::Codex);
    assert_eq!(launch.permission_mode, PermissionMode::Native);
    assert_eq!(launch.model.as_ref().expect("model").id, "parent-model");
    assert_eq!(launch.thinking_level.as_deref(), Some("high"));
    assert!(launch.network_access);
    assert_eq!(
        host.sends()[0].1,
        first_prompt("Title parent", "Complete this work")
    );
}

#[tokio::test]
async fn session_links_explicit_modes_and_models_do_not_raise_authority() {
    let (broker, host, _) = setup();
    let answer = call(&broker, "parent", json!({"op":"start","title":"Research","prompt":"Read the notes","harness":"hermes","permissionMode":"read-only","model":{"provider":"local","id":"small"}})).await;
    assert_eq!(answer["ok"], true, "{answer}");
    let data = host.data.lock().expect("data");
    let launch = &data.launches[0];
    assert_eq!(launch.harness, HarnessKind::Hermes);
    assert_eq!(launch.permission_mode, PermissionMode::ReadOnly);
    assert_eq!(launch.model.as_ref().expect("model").id, "small");
    assert_eq!(
        launch.model.as_ref().expect("model").provider.as_deref(),
        Some("local")
    );
    assert_eq!(launch.thinking_level, None);
    assert!(!launch.network_access);
}

#[tokio::test]
async fn session_links_read_only_and_native_modes_are_compared_before_launch() {
    let (broker, host, _) = setup();
    for (parent_mode, child_mode, harness) in [
        (PermissionMode::Native, "read-only", "hermes"),
        (PermissionMode::ReadOnly, "workspace-write", "codex"),
        (PermissionMode::FullAccess, "native", "codex"),
        (PermissionMode::FullAccess, "workspace-write", "claude-code"),
        (PermissionMode::FullAccess, "read-only", "pi"),
    ] {
        host.data
            .lock()
            .expect("data")
            .sessions
            .get_mut("parent")
            .expect("parent")
            .permission_mode = parent_mode;
        let refused = call(&broker, "parent", json!({"op":"start","title":"No escalation","prompt":"work","harness":harness,"permissionMode":child_mode})).await;
        assert_eq!(refused["code"], "authority-denied", "{refused}");
        assert_eq!(
            refused["message"],
            "The linked chat would have more authority than this chat, or the two cannot be compared. On another harness set permissionMode at or below this chat's explicit mode."
        );
    }
    assert!(host.data.lock().expect("data").launches.is_empty());
    host.data
        .lock()
        .expect("data")
        .sessions
        .get_mut("parent")
        .expect("parent")
        .permission_mode = PermissionMode::ReadOnly;
    assert_eq!(
        call(
            &broker,
            "parent",
            json!({"op":"start","title":"Read only","prompt":"work"})
        )
        .await["ok"],
        true
    );
}

#[tokio::test]
async fn session_links_limits_depth_and_open_agent_children() {
    let (broker, host, _) = setup();
    let child = started(&broker).await;
    assert_eq!(
        call(
            &broker,
            &child,
            json!({"op":"start","title":"Too deep","prompt":"work"})
        )
        .await["code"],
        "depth-limit"
    );
    broker
        .adopt_child("parent", "other", LinkKind::Branch)
        .await
        .expect("branch link");
    assert_eq!(
        call(
            &broker,
            "other",
            json!({"op":"start","title":"Too deep","prompt":"work"})
        )
        .await["code"],
        "depth-limit"
    );
    for _ in 1..MAX_AGENT_CHILDREN {
        started(&broker).await;
    }
    assert_eq!(
        call(
            &broker,
            "parent",
            json!({"op":"start","title":"Over limit","prompt":"work"})
        )
        .await["code"],
        "child-limit"
    );
    assert_eq!(
        host.data.lock().expect("data").launches.len(),
        MAX_AGENT_CHILDREN
    );
    call(&broker, "parent", json!({"op":"stop","sessionId":child})).await;
    assert_eq!(
        call(
            &broker,
            "parent",
            json!({"op":"start","title":"A free slot","prompt":"work"})
        )
        .await["ok"],
        true
    );
}

#[tokio::test]
async fn session_links_refusal_codes_and_shape_validation() {
    let (broker, host, _) = setup();
    for invalid in [
        json!({"op":"unknown"}),
        json!({"op":"list","extra":true}),
        json!({"op":"start","title":" ","prompt":"work"}),
        json!({"op":"start","title":"Good","prompt":""}),
        json!({"op":"start","title":"Good","prompt":"x".repeat(TEXT_CHARS+1)}),
        json!({"op":"start","title":"Good","prompt":"work","harness":"acp:--bad"}),
        json!({"op":"start","title":"Good","prompt":"work","model":{"provider":"p","id":""}}),
        json!({"op":"start","title":"Good","prompt":"work","model":{"provider":"p","id":"m","extra":true}}),
        json!({"op":"wait","sessionId":"other","waitSeconds":241}),
        json!({"op":"wait","sessionId":"other","waitSeconds":0.5}),
        json!({"op":"read","sessionId":"../other","page":1}),
        json!({"op":"read","sessionId":"other","page":0}),
        json!({"op":"message","sessionId":"other","text":"hello","wait":null}),
    ] {
        assert_eq!(
            call(&broker, "parent", invalid).await["code"],
            "invalid-operation"
        );
    }
    assert_eq!(
        call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":"other","text":"hello"})
        )
        .await["code"],
        "unknown-session"
    );
    host.data
        .lock()
        .expect("data")
        .unavailable
        .push(HarnessKind::Hermes);
    assert_eq!(call(&broker, "parent", json!({"op":"start","title":"Child","prompt":"work","harness":"hermes","permissionMode":"read-only"})).await["code"], "harness-unavailable");
    broker.set_enabled(false);
    assert_eq!(
        call(&broker, "parent", json!({"op":"list"})).await["code"],
        "not-allowed"
    );
    broker.set_enabled(true);
    broker.link("parent", "other").expect("peer link");
    for error in [ErrorCode::Busy, ErrorCode::Unavailable] {
        host.data.lock().expect("data").fail = Some(error);
        let result = call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":"other","text":"hello"}),
        )
        .await;
        assert_eq!(result["code"], serde_json::to_value(error).expect("code"));
    }
    assert!(host.data.lock().expect("data").launches.is_empty());
}

#[tokio::test]
async fn session_links_message_selects_prompt_or_follow_up_and_frames_untrusted_text() {
    for target_state in [LinkedChatState::Idle, LinkedChatState::Running] {
        let (broker, host, _) = setup();
        host.data
            .lock()
            .expect("data")
            .sessions
            .get_mut("other")
            .expect("other")
            .state = target_state;
        broker.link("parent", "other").expect("peer link");
        let result = call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":"other","text":"Check the result"}),
        )
        .await;
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["queued"], false);
        let sent = host.sends();
        assert_eq!(
            sent[0].1,
            message_prompt("Title parent", "Check the result", false)
        );
        assert_eq!(
            sent[0].2,
            if target_state == LinkedChatState::Running {
                PromptMode::FollowUp
            } else {
                PromptMode::Prompt
            }
        );
    }
}

#[tokio::test]
async fn session_links_reports_go_to_a_waiter_or_the_asking_chat_once() {
    let (broker, host, _) = setup();
    host.auto.store(true, Ordering::Release);
    let waiting = call(
        &broker,
        "parent",
        json!({"op":"start","title":"Waited child","prompt":"work","wait":true,"waitSeconds":240}),
    )
    .await;
    assert_eq!(waiting["answer"], "A complete answer");
    assert_eq!(
        host.sends().len(),
        1,
        "the waiter claims the report; no automatic report"
    );
    let background = call(
        &broker,
        "parent",
        json!({"op":"start","title":"Background child","prompt":"work"}),
    )
    .await;
    assert_eq!(background["ok"], true);
    wait_for_send(&host, |(_, text, _)| {
        text.starts_with("Report from the linked chat \"Background child\"")
    })
    .await;
    let reports: Vec<_> = host
        .sends()
        .into_iter()
        .filter(|(_, text, _)| text.starts_with("Report from"))
        .collect();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].0, "parent");
    assert_eq!(
        reports[0].1,
        report_prompt(
            "Background child",
            background["sessionId"].as_str().expect("id"),
            "A complete answer"
        )
    );
}

#[tokio::test]
async fn session_links_wait_claims_an_already_running_requested_turn() {
    let (broker, host, _) = setup();
    let child = started(&broker).await;
    let waiting = {
        let broker = broker.clone();
        let child = child.clone();
        tokio::spawn(async move {
            call(
                &broker,
                "parent",
                json!({"op":"wait","sessionId":child,"waitSeconds":240}),
            )
            .await
        })
    };
    tokio::task::yield_now().await;
    host.finish(&child, "Finished for the waiter", 1);
    let result = waiting.await.expect("wait task");
    assert_eq!(result["answer"], "Finished for the waiter");
    assert!(
        !host
            .sends()
            .iter()
            .any(|(_, text, _)| text.starts_with("Report from"))
    );
}

#[tokio::test]
async fn session_links_reports_are_cut_by_characters_and_read_uses_utf8_pages() {
    let (broker, host, _) = setup();
    let text = "Ж".repeat(REPORT_CHARS + 500);
    *host.response.lock().expect("response") = text.clone();
    host.auto.store(true, Ordering::Release);
    let answer = call(
        &broker,
        "parent",
        json!({"op":"start","title":"Long child","prompt":"work","wait":true}),
    )
    .await;
    assert_eq!(answer["cut"], true);
    assert_eq!(
        answer["answer"].as_str().expect("answer").chars().count(),
        REPORT_CHARS
    );
    let id = answer["sessionId"].as_str().expect("id");
    let report = report_prompt("Long child", id, &text);
    assert!(report.ends_with(&format!("[Cut. Read the full answer with the sessions tool: {{\"op\":\"read\",\"sessionId\":\"{id}\"}}]")));
    host.finish(id, &"Ж".repeat(PAGE_BYTES), 1);
    let first = call(
        &broker,
        "parent",
        json!({"op":"read","sessionId":id,"page":1}),
    )
    .await;
    let second = call(
        &broker,
        "parent",
        json!({"op":"read","sessionId":id,"page":2}),
    )
    .await;
    assert_eq!(first["pages"], 2);
    assert_eq!(first["text"].as_str().expect("page").len(), PAGE_BYTES);
    assert_eq!(second["text"].as_str().expect("page").len(), PAGE_BYTES);
}

#[tokio::test]
async fn session_links_loop_guard_keeps_pending_newest_twenty_and_person_resets_it() {
    let (broker, host, store) = setup();
    broker.link("parent", "other").expect("peer link");
    for index in 0..MAX_WAKES {
        let answer = call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":"other","text":format!("wake {index}")}),
        )
        .await;
        assert_eq!(answer["queued"], false);
        host.finish("other", "noted", 1);
    }
    for index in 0..=MAX_PENDING {
        assert_eq!(
            call(
                &broker,
                "parent",
                json!({"op":"message","sessionId":"other","text":format!("pending {index}")})
            )
            .await["queued"],
            true
        );
    }
    let (links, _) = broker.list("other").expect("links");
    assert_eq!(links[0].pending, MAX_PENDING);
    {
        let documents = store.documents.lock().expect("documents");
        assert_eq!(documents["other"].wakes, MAX_WAKES);
        assert!(
            documents["other"].links[0]
                .pending
                .first()
                .expect("pending")
                .text
                .ends_with("pending 1")
        );
    }
    broker.person_message("other").await;
    assert_eq!(store.documents.lock().expect("documents")["other"].wakes, 0);
    broker
        .deliver("other", "parent")
        .await
        .expect("person delivers pending");
    assert_eq!(broker.list("other").expect("links").0[0].pending, 0);
    assert!(
        host.sends()
            .iter()
            .any(|(_, text, _)| text.ends_with(&format!("pending {MAX_PENDING}")))
    );
}

#[tokio::test]
async fn session_links_person_message_in_parent_restores_agent_and_branch_child_budgets() {
    let (broker, host, store) = setup();
    let agent = started(&broker).await;
    host.finish(&agent, "Initial work", 1);
    broker
        .adopt_child("parent", "other", LinkKind::Branch)
        .await
        .expect("branch link");
    for (child, used) in [(agent.as_str(), 1), ("other", 0)] {
        for index in used..MAX_WAKES {
            let result = call(
                &broker,
                "parent",
                json!({"op":"message","sessionId":child,"text":format!("work {index}")}),
            )
            .await;
            assert_eq!(result["queued"], false);
            host.finish(child, "Done", 1);
        }
        assert_eq!(
            store.documents.lock().expect("documents")[child].wakes,
            MAX_WAKES
        );
        let blocked = call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":child,"text":"Waiting for the person"}),
        )
        .await;
        assert_eq!(blocked["queued"], true);
    }
    host.add(info("peer"));
    broker.link("parent", "peer").expect("peer link");
    call(
        &broker,
        "parent",
        json!({"op":"message","sessionId":"peer","text":"A peer request"}),
    )
    .await;
    let peer_wakes = store.documents.lock().expect("documents")["peer"].wakes;

    broker.person_message("parent").await;
    {
        let documents = store.documents.lock().expect("documents");
        assert_eq!(documents["parent"].wakes, 0);
        assert_eq!(documents[&agent].wakes, 0);
        assert_eq!(documents["other"].wakes, 0);
        assert_eq!(
            documents["peer"].wakes, peer_wakes,
            "a parent message does not reset its peers"
        );
    }
    for child in [agent.as_str(), "other"] {
        let accepted = call(&broker, "parent", json!({"op":"message","sessionId":child,"text":"A new request after the person's message"})).await;
        assert_eq!(accepted["queued"], false);
        assert!(
            host.sends()
                .iter()
                .any(|(target, text, _)| target.as_str() == child
                    && text.ends_with("A new request after the person's message"))
        );
    }
}

#[tokio::test]
async fn session_links_person_send_is_distinct_resets_wakes_and_works_with_tool_disabled() {
    let (broker, host, store) = setup();
    broker.link("parent", "other").expect("peer link");
    broker.set_enabled(false);
    broker
        .send_person("parent", "other", "Please read this")
        .await
        .expect("person send");
    assert_eq!(
        host.sends()[0].1,
        message_prompt("Title parent", "Please read this", true)
    );
    assert_eq!(store.documents.lock().expect("documents")["other"].wakes, 0);
    assert_eq!(
        broker.send_person("parent", "missing", "hello").await,
        Err(ErrorCode::UnknownSession)
    );
}

#[tokio::test]
async fn session_links_peer_links_are_symmetric_emit_changes_and_can_be_removed() {
    let (broker, _, _) = setup();
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    broker.set_notifier(Arc::new(move |id, revision| {
        recorded
            .lock()
            .expect("events")
            .push((id.to_owned(), revision))
    }));
    broker.link("parent", "other").expect("link");
    for id in ["parent", "other"] {
        let (links, revision) = broker.list(id).expect("list");
        assert_eq!(links[0].relation, Relation::Peer);
        assert_eq!(revision, 1);
    }
    assert_eq!(events.lock().expect("events").len(), 2);
    broker.unlink("parent", "other").expect("unlink");
    assert!(broker.list("other").expect("list").0.is_empty());
    assert!(broker.list("parent").expect("list").0.is_empty());
}

#[tokio::test]
async fn session_links_only_a_parent_can_stop_its_child_and_deletion_removes_links() {
    let (broker, host, store) = setup();
    let child = started(&broker).await;
    broker.link("parent", "other").expect("peer link");
    assert_eq!(
        call(&broker, "parent", json!({"op":"stop","sessionId":"other"})).await["code"],
        "not-allowed"
    );
    assert_eq!(
        call(&broker, &child, json!({"op":"stop","sessionId":"parent"})).await["code"],
        "not-allowed"
    );
    assert_eq!(
        call(&broker, "parent", json!({"op":"stop","sessionId":child})).await["state"],
        "closed"
    );
    assert_eq!(
        host.data.lock().expect("data").interrupted,
        vec![child.clone()]
    );
    broker.session_deleted(&child).await;
    assert!(
        !broker
            .list("parent")
            .expect("list")
            .0
            .iter()
            .any(|entry| entry.session_id == child)
    );
    assert!(
        !store
            .documents
            .lock()
            .expect("documents")
            .contains_key(&child)
    );
}

#[tokio::test]
async fn session_links_restart_preserves_links_reports_pending_and_wakes() {
    let (broker, host, store) = setup();
    broker.link("parent", "other").expect("link");
    for index in 0..MAX_WAKES {
        call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":"other","text":format!("work {index}")}),
        )
        .await;
        host.finish("other", "done", 1);
    }
    call(
        &broker,
        "parent",
        json!({"op":"message","sessionId":"other","text":"pending across restart"}),
    )
    .await;
    let before = broker.list("other").expect("links").0;
    let restored = LinksBroker::new(Arc::new(host), store.clone(), true, true);
    let after = restored.list("other").expect("restored").0;
    assert_eq!(after[0].pending, before[0].pending);
    assert_eq!(after[0].relation, Relation::Peer);
    assert_eq!(
        store.documents.lock().expect("documents")["other"].wakes,
        MAX_WAKES
    );
}

#[tokio::test]
async fn session_links_pending_overflow_retires_dropped_requests_before_a_later_wait() {
    let (broker, host, store) = setup();
    broker.link("parent", "other").expect("link");
    // Seed the persisted loop guard exactly at its specified limit.
    {
        let mut documents = store.documents.lock().expect("documents");
        documents.get_mut("other").expect("other").wakes = MAX_WAKES;
    }
    let broker = LinksBroker::new(Arc::new(host.clone()), store, true, true);
    for index in 0..=MAX_PENDING {
        call(
            &broker,
            "parent",
            json!({"op":"message","sessionId":"other","text":format!("request {index}")}),
        )
        .await;
    }
    assert_eq!(
        broker.in_flight_count(),
        MAX_PENDING,
        "dropped pending requests cannot keep unresolved wait tickets"
    );
    broker.deliver("other", "parent").await.expect("deliver");
    host.finish(
        "other",
        "All retained requests completed",
        MAX_PENDING as u64 * 2,
    );
    while broker.in_flight_count() != 0 {
        tokio::task::yield_now().await;
    }
    let waited = call(
        &broker,
        "parent",
        json!({"op":"wait","sessionId":"other","waitSeconds":0}),
    )
    .await;
    assert_eq!(waited["answer"], "All retained requests completed");
}

#[tokio::test]
async fn session_links_restored_pending_request_still_reports_its_answer() {
    let (broker, host, store) = setup();
    broker.link("parent", "other").expect("link");
    {
        let mut documents = store.documents.lock().expect("documents");
        documents.get_mut("other").expect("other").wakes = MAX_WAKES;
    }
    let broker = LinksBroker::new(Arc::new(host.clone()), store.clone(), true, true);
    let queued = call(
        &broker,
        "parent",
        json!({"op":"message","sessionId":"other","text":"Work surviving the restart"}),
    )
    .await;
    assert_eq!(queued["queued"], true);
    assert!(host.sends().is_empty());
    drop(broker);
    host.auto.store(true, Ordering::Release);
    let restored = LinksBroker::new(Arc::new(host.clone()), store.clone(), true, true);
    restored
        .deliver("other", "parent")
        .await
        .expect("deliver after restart");
    wait_for_send(&host, |(_, text, _)| {
        text.starts_with("Report from the linked chat")
    })
    .await;
    assert_eq!(
        host.sends()
            .iter()
            .filter(|(_, text, _)| text.starts_with("Report from the linked chat"))
            .count(),
        1
    );
    let (links, _) = restored.list("parent").expect("links");
    assert_eq!(
        links[0].last_report.as_ref().expect("report").excerpt,
        "A complete answer"
    );
    assert!(!store.documents.lock().expect("documents")["parent"].links[0].asked_turn);
}

#[test]
fn session_links_branch_origin_is_optional_in_older_documents() {
    let older = json!({"protocol":1,"session_id":"old-chat","links":[],"wakes":0});
    let document: SessionDocument = serde_json::from_value(older.clone()).expect("old document");
    assert_eq!(document.branch, None);
    assert_eq!(
        serde_json::to_value(document).expect("serialize document"),
        older
    );
    let origin: BranchOrigin =
        serde_json::from_value(json!({"source_session_id":"source","mode":"native"}))
            .expect("end-of-chat native origin");
    assert_eq!(origin.mode, BranchMode::Native);
    assert_eq!(origin.before_block_id, None);
    assert_eq!(
        serde_json::to_value(origin).expect("serialize origin"),
        json!({"source_session_id":"source","mode":"native"})
    );
}

#[tokio::test]
async fn session_links_branch_origins_persist_without_links_or_preference_and_can_be_removed() {
    let root = std::env::temp_dir().join(format!("piui-branch-origin-{}", uuid::Uuid::new_v4()));
    let host = FakeHost::default();
    let store = Arc::new(FileLinksStore::open(&root).expect("store"));
    let broker = LinksBroker::new(Arc::new(host.clone()), store.clone(), false, true);
    let origins = [
        (
            "linked-child",
            BranchOrigin {
                source_session_id: "source".into(),
                mode: BranchMode::Linked,
                before_block_id: None,
            },
        ),
        (
            "native-cut-child",
            BranchOrigin {
                source_session_id: "source".into(),
                mode: BranchMode::Native,
                before_block_id: Some("assistant-cut".into()),
            },
        ),
        (
            "native-end-child",
            BranchOrigin {
                source_session_id: "source".into(),
                mode: BranchMode::Native,
                before_block_id: None,
            },
        ),
    ];
    for (child, origin) in &origins {
        broker
            .record_branch(child, origin.clone())
            .expect("records before native creation, with preference off");
        assert_eq!(broker.branch_origin(child), Some(origin.clone()));
    }
    drop(broker);
    let restored = LinksBroker::new(
        Arc::new(host.clone()),
        Arc::new(FileLinksStore::open(&root).expect("reopened store")),
        false,
        true,
    );
    for (child, origin) in &origins {
        assert_eq!(
            restored.branch_origin(child),
            Some(origin.clone()),
            "origin-only documents survive reload"
        );
    }
    restored.forget_branch("native-cut-child");
    restored.session_deleted("linked-child").await;
    assert_eq!(restored.branch_origin("native-cut-child"), None);
    assert_eq!(restored.branch_origin("linked-child"), None);
    drop(restored);
    let reopened = LinksBroker::new(
        Arc::new(host),
        Arc::new(FileLinksStore::open(&root).expect("reopened after cleanup")),
        true,
        true,
    );
    assert_eq!(reopened.branch_origin("native-cut-child"), None);
    assert_eq!(reopened.branch_origin("linked-child"), None);
    assert_eq!(
        reopened.branch_origin("native-end-child"),
        Some(origins[2].1.clone())
    );
    drop(reopened);
    drop(store);
    std::fs::remove_dir_all(root).expect("removes fixture");
}

#[test]
fn session_links_branch_origin_survives_unlinking_its_last_link() {
    let (broker, host, store) = setup();
    broker.set_enabled(false);
    let origin = BranchOrigin {
        source_session_id: "parent".into(),
        mode: BranchMode::Linked,
        before_block_id: None,
    };
    broker
        .record_branch("other", origin.clone())
        .expect("origin");
    broker.link("parent", "other").expect("link");
    broker.unlink("parent", "other").expect("unlink");
    {
        let documents = store.documents.lock().expect("documents");
        assert!(documents["other"].links.is_empty());
        assert_eq!(documents["other"].wakes, 0);
        assert_eq!(documents["other"].branch, Some(origin.clone()));
    }
    let restored = LinksBroker::new(Arc::new(host), store, false, true);
    assert_eq!(restored.branch_origin("other"), Some(origin));
}

#[test]
fn session_links_store_generations_skip_damage_and_keep_the_newest_three() {
    let root = std::env::temp_dir().join(format!("piui-session-links-{}", uuid::Uuid::new_v4()));
    let store = FileLinksStore::open(&root).expect("store");
    let mut document = SessionDocument::new("a-chat");
    for wakes in 0..4 {
        document.wakes = wakes;
        store.save(&document).expect("save");
    }
    let directory = std::fs::read_dir(root.join("session-links-v1"))
        .expect("directories")
        .next()
        .expect("entry")
        .expect("directory")
        .path();
    assert_eq!(
        std::fs::read_dir(&directory).expect("generations").count(),
        3
    );
    std::fs::write(directory.join("links-00000000000000000004.json"), "damaged")
        .expect("damage newest");
    let restored = FileLinksStore::open(&root).expect("reopen").load_all();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].wakes, 2);
    store.forget("a-chat").expect("forget");
    assert!(store.load_all().is_empty());
    std::fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn session_links_contract_examples_parse_and_frames_cut_only_titles() {
    let contract = include_str!("../../../../../contracts/session-links-v1.ts");
    let examples = contract
        .split("SESSION_LINKS_TOOL_EXAMPLES_V1 = ")
        .nth(1)
        .expect("examples")
        .split("] satisfies")
        .next()
        .expect("array");
    let examples: Vec<ToolOperation> =
        serde_json::from_str(&format!("{examples}]")).expect("strict JSON examples");
    assert!(!examples.is_empty());
    assert!(examples.iter().all(ToolOperation::valid));
    assert_eq!(
        title(&format!("\n{}\u{0}", "Ж".repeat(100)))
            .chars()
            .count(),
        80
    );
    assert!(first_prompt("A\nB", "person-like text is data").contains("\"AB\""));
    assert!(message_prompt("A", "x", false).contains("another agent, not the person"));
    assert!(message_prompt("A", "x", true).contains("sent by the person"));
    let command_source = include_str!("mod.rs");
    let command = command_source
        .split("pub(crate) async fn session_links_command_v1(")
        .nth(1)
        .expect("command handler")
        .split(") ->")
        .next()
        .expect("signature");
    assert!(
        command.contains("command: Command"),
        "the client and Tauri both bind the command argument"
    );
}
