/* /js/game.js
   모바일 TRPG 클라이언트 렌더러 (Gemini /api/story.js 응답 JSON 스키마 기반)
   - 스크롤 없이(overflow hidden) "페이지 넘김" 방식으로 narration+dialogue를 표시
   - choice 클릭 -> /api/story POST -> 다음 JSON 렌더
   - state를 localStorage에 저장(이어하기)
*/

(() => {
    const API_URL = "/api/story"; // vercel serverless function 경로

    // ===== DOM =====
    const elBg = document.getElementById("bg");

    const elArcTitle = document.getElementById("arcTitle");
    const elSceneTitle = document.getElementById("sceneTitle");
    const elLocation = document.getElementById("location");
    const elTime = document.getElementById("time");

    const elStatFocus = document.getElementById("statFocus");
    const elStatTalent = document.getElementById("statTalent");
    const elStatReason = document.getElementById("statReason");
    const elStatBond = document.getElementById("statBond");

    const elAvatarImg = document.getElementById("avatarImg");
    const elSpotlightWrap = document.getElementById("spotlightWrap");
    const elSpotlightImg = document.getElementById("spotlightImg");

    const elNarration = document.getElementById("narration");
    const elDialogueList = document.getElementById("dialogueList");
    const elChoices = document.getElementById("choices");
    const elNextHint = document.getElementById("nextHint");

    // ===== Storage Keys =====
    const LS_KEY = "ariel_trpg_save_v1";

    // ===== State (client) =====
    const runtime = {
        state: null,          // 서버에 보낼 state (전체 저장 상태)
        lastScene: null,      // 마지막으로 받은 GM JSON
        pageIndex: 0,         // 현재 페이지
        pages: [],            // [{ narration, dialogue[] }]
        isBusy: false,
    };

    // ===== Helpers =====
    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
    }

    function safeText(v) {
        if (v == null) return "";
        return String(v);
    }

    function setBusy(b) {
        runtime.isBusy = b;
        document.body.style.cursor = b ? "progress" : "";
        // 선택지 버튼 disable
        const btns = elChoices.querySelectorAll("button");
        btns.forEach((btn) => (btn.disabled = b));
        // next hint
        elNextHint.disabled = b;
        elNextHint.style.opacity = b ? "0.6" : "1";
    }

    function showToast(msg) {
        // 간단 토스트(스크롤 없이)
        const t = document.createElement("div");
        t.textContent = msg;
        t.style.position = "fixed";
        t.style.left = "50%";
        t.style.bottom = "18px";
        t.style.transform = "translateX(-50%)";
        t.style.padding = "10px 12px";
        t.style.borderRadius = "999px";
        t.style.background = "rgba(0,0,0,.65)";
        t.style.border = "1px solid rgba(255,255,255,.12)";
        t.style.color = "rgba(255,255,255,.92)";
        t.style.backdropFilter = "blur(10px)";
        t.style.zIndex = "9999";
        t.style.maxWidth = "84vw";
        t.style.whiteSpace = "nowrap";
        t.style.overflow = "hidden";
        t.style.textOverflow = "ellipsis";
        document.body.appendChild(t);

        setTimeout(() => {
            t.style.transition = "opacity .25s ease, transform .25s ease";
            t.style.opacity = "0";
            t.style.transform = "translateX(-50%) translateY(6px)";
            setTimeout(() => t.remove(), 260);
        }, 1200);
    }

    function loadSave() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    function saveGame(payload) {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(payload));
        } catch {
            // ignore
        }
    }

    function clearChildren(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function buildCharPath(id, expression) {
        const safeId = encodeURIComponent(id || "unknown");
        const safeEx = encodeURIComponent(expression || "neutral");
        return `/img/chars/${safeId}/${safeEx}.png`;
    }

    function buildBgPath(bgKey) {
        // jpg 기본, 필요하면 png로 바꿔도 됨
        const key = encodeURIComponent(bgKey || "");
        if (!key) return null;
        return `/img/bg/${key}.jpg`;
    }

    // ===== Pagination without scroll =====
    // 목표: narration(최대 N줄) + dialogue(최대 M줄)
    // - 실제 높이 측정으로 “넘치면” 페이지를 쪼개는 방식
    // - 현재 DOM에 임시로 렌더 → overflow 여부 검사 → 쪼갬
    //
    // 주의: CSS에서 narration/dialogue 영역은 overflow hidden이므로
    // scrollHeight > clientHeight 로 넘침 판단 가능.
    function createPages(scene) {
        const narration = safeText(scene?.narration);
        const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];

        // 대사를 "문장 단위"로 쪼개기
        // 너무 공격적으로 쪼개면 어색하니, 1차는 줄(대사 하나) 단위.
        const dialogueLines = dialogue.map((d) => ({
            speaker: safeText(d?.speaker),
            text: safeText(d?.text),
        }));

        // narration은 문장 단위로 분할(., ?, !, …, 줄바꿈)
        const narrationParts = splitNarration(narration);

        // 페이지 구성: narrationParts + dialogueLines를 순서대로 담되,
        // 화면을 넘치게 하면 페이지를 확정하고 다음 페이지로.
        const pages = [];

        // 임시로 “측정용” 렌더링을 반복할 것이므로,
        // 현재 UI 영역을 이용한다(사용자에겐 페이지 넘어갈 때만 보임).
        // -> 페이지 생성 중엔 busy 처리.
        clearChildren(elDialogueList);

        let nIdx = 0;
        let dIdx = 0;

        // 최소 한 페이지는 생성
        while (nIdx < narrationParts.length || dIdx < dialogueLines.length) {
            let pageNarr = "";
            const pageDia = [];

            // 1) narration 먼저 가능한 만큼 넣기
            while (nIdx < narrationParts.length) {
                const candidate = pageNarr ? pageNarr + " " + narrationParts[nIdx] : narrationParts[nIdx];

                // 임시 적용
                elNarration.textContent = candidate;
                renderDialogueLines(pageDia);

                if (isOverflowingTextArea()) break;

                pageNarr = candidate;
                nIdx++;
            }

            // 2) dialogue 가능한 만큼 넣기
            while (dIdx < dialogueLines.length) {
                pageDia.push(dialogueLines[dIdx]);

                // 임시 적용
                elNarration.textContent = pageNarr || " ";
                renderDialogueLines(pageDia);

                if (isOverflowingTextArea()) {
                    // 방금 넣은 라인 빼고 다음 페이지로 넘김
                    pageDia.pop();
                    break;
                }
                dIdx++;
            }

            // 페이지가 너무 비어있으면(예: 한 줄도 못 넣는 경우) 안전장치로 강제 1개 넣기
            if (!pageNarr && pageDia.length === 0) {
                if (nIdx < narrationParts.length) {
                    pageNarr = narrationParts[nIdx++];
                } else if (dIdx < dialogueLines.length) {
                    pageDia.push(dialogueLines[dIdx++]);
                }
            }

            pages.push({ narration: pageNarr.trim(), dialogue: pageDia });
        }

        // 마지막으로 현재 씬 렌더링에 맞게 초기화
        if (pages.length === 0) pages.push({ narration: narration, dialogue: dialogueLines });

        return pages;
    }

    function splitNarration(text) {
        const t = safeText(text).replace(/\s+/g, " ").trim();
        if (!t) return [];
        // 한국어 문장 분리(마침표/물음표/느낌표/말줄임표 기준)
        const parts = t
            .split(/(?<=[\.\?\!…])\s+/g)
            .map((s) => s.trim())
            .filter(Boolean);

        // 너무 긴 덩어리는 쉼표 기준으로 2차 분리
        const refined = [];
        for (const p of parts) {
            if (p.length <= 90) {
                refined.push(p);
            } else {
                const chunks = p.split(/,\s*/g).map((x) => x.trim()).filter(Boolean);
                if (chunks.length <= 1) refined.push(p);
                else refined.push(...chunks.map((c, i) => (i < chunks.length - 1 ? c + "," : c)));
            }
        }
        return refined.length ? refined : [t];
    }

    function renderDialogueLines(lines) {
        clearChildren(elDialogueList);

        for (const l of lines) {
            const row = document.createElement("div");
            row.className = "line";

            const sp = document.createElement("span");
            sp.className = "speaker";
            sp.textContent = l.speaker || "";

            const co = document.createElement("span");
            co.className = "colon";
            co.textContent = ":";

            const say = document.createElement("span");
            say.className = "say";
            say.textContent = l.text || "";

            row.appendChild(sp);
            row.appendChild(co);
            row.appendChild(say);
            elDialogueList.appendChild(row);
        }
    }

    function isOverflowingTextArea() {
        // narration: line-clamp 때문에 scrollHeight 판정이 애매할 수 있어
        // 하지만 우리는 dialogueList max-height + overflow hidden 이라서
        // 둘 다 체크해서 안정적으로 판단.
        const diaOverflow = elDialogueList.scrollHeight > elDialogueList.clientHeight + 1;

        // narration은 line-clamp(웹킷)인데 scrollHeight가 커지는 경우가 있음.
        // 그래도 안전하게 체크.
        const narOverflow = elNarration.scrollHeight > elNarration.clientHeight + 1;

        return diaOverflow || narOverflow;
    }

    // ===== Render Scene =====
    function renderScene(scene) {
        runtime.lastScene = scene;

        // Chapter
        const ch = scene?.chapter || {};
        const year = ch.schoolYear != null ? `${ch.schoolYear}학년` : "";
        const term = ch.term ? termToKo(ch.term) : "";
        elArcTitle.textContent = [year, term].filter(Boolean).join(" ") || safeText(ch.arcTitle) || "진행 중";
        elSceneTitle.textContent = safeText(ch.sceneTitle || ch.arcTitle || "장면");
        elLocation.textContent = safeText(ch.location || "");
        elTime.textContent = safeText(ch.time || "");

        // Stats (statePatch.stats는 "델타"가 아니라 현재값처럼 쓰는 형태로 두었으니 그대로 표시)
        const sp = scene?.statePatch?.stats || {};
        elStatFocus.textContent = String(sp.focus ?? 0);
        elStatTalent.textContent = String(sp.talent ?? 0);
        elStatReason.textContent = String(sp.reason ?? 0);
        elStatBond.textContent = String(sp.bond ?? 0);

        // Visuals
        applyVisuals(scene?.visuals);

        // Pages (no scroll)
        // 페이지 생성은 “측정 렌더”가 포함되므로 UX 상 짧게 busy 처리
        setBusy(true);
        // 다음 프레임에서 계산(레이아웃 안정화)
        requestAnimationFrame(() => {
            runtime.pages = createPages(scene);
            runtime.pageIndex = 0;
            renderPage(runtime.pageIndex);
            renderChoices(scene?.choices);
            setBusy(false);

            // 세이브
            // 저장할 “state”는 서버에 다시 보내는 state 값으로 사용
            // 여기서는 scene 전체를 state로 저장해도 되지만,
            // /api/story.js 는 body.state 를 “프론트에서 저장한 전체 상태(JSON)”로 받으므로
            // scene.statePatch 기반으로 누적 state를 유지하는 편이 안정적.
            // => 여기서는 "clientState" 구조를 별도로 관리함.
            persistClientState(scene);
        });
    }

    function termToKo(term) {
        switch (term) {
            case "Fall": return "가을";
            case "Winter": return "겨울";
            case "Spring": return "봄";
            case "Summer": return "여름";
            default: return safeText(term);
        }
    }

    function applyVisuals(visuals) {
        const bgKey = safeText(visuals?.bgKey);
        const bgPath = buildBgPath(bgKey);
        if (bgPath && elBg) {
            elBg.style.backgroundImage = `url("${bgPath}")`;
            // 이미지가 없을 때 깨지는 것 방지: 로드 실패 시 기본 배경 유지
            const img = new Image();
            img.onload = () => (elBg.style.backgroundImage = `url("${bgPath}")`);
            img.onerror = () => {
                // fallback: 기본 그라데이션 유지
                elBg.style.backgroundImage = "";
            };
            img.src = bgPath;
        }

        // spotlight / avatar
        const chars = Array.isArray(visuals?.characters) ? visuals.characters : [];
        const spotlightId = safeText(visuals?.spotlight);

        // 아바타: ariel 우선 -> spotlight -> 첫번째
        const ariel = chars.find((c) => c?.id === "ariel");
        const spot = chars.find((c) => c?.id === spotlightId);
        const pick = ariel || spot || chars[0];

        if (pick?.id) {
            elAvatarImg.src = buildCharPath(pick.id, pick.expression || "neutral");
            elAvatarImg.alt = pick.id;
        } else {
            elAvatarImg.src = buildCharPath("ariel", "neutral");
            elAvatarImg.alt = "ariel";
        }

        // spotlight big image는 선택(있을 때만)
        if (spotlightId) {
            const s = chars.find((c) => c?.id === spotlightId);
            if (s?.id) {
                elSpotlightImg.src = buildCharPath(s.id, s.expression || "neutral");
                elSpotlightImg.alt = s.id;
                elSpotlightImg.style.display = "block";
                elSpotlightWrap.style.opacity = "1";
            } else {
                elSpotlightImg.style.display = "none";
                elSpotlightWrap.style.opacity = "0";
            }
        } else {
            elSpotlightImg.style.display = "none";
            elSpotlightWrap.style.opacity = "0";
        }
    }

    function renderPage(idx) {
        idx = clamp(idx, 0, runtime.pages.length - 1);
        runtime.pageIndex = idx;

        const p = runtime.pages[idx] || { narration: "", dialogue: [] };
        elNarration.textContent = p.narration || "";

        renderDialogueLines(p.dialogue || []);

        // next hint 표시 여부
        const hasNext = runtime.pageIndex < runtime.pages.length - 1;
        elNextHint.style.display = hasNext ? "inline-flex" : "none";
    }

    function renderChoices(choices) {
        clearChildren(elChoices);

        const arr = Array.isArray(choices) ? choices : [];
        const safeArr = arr.slice(0, 3);

        if (safeArr.length === 0) {
            const btn = document.createElement("button");
            btn.className = "choiceBtn";
            btn.type = "button";
            btn.innerHTML = `
        <span class="choiceId">!</span>
        <span class="choiceText">선택지가 없습니다. (다시 시도)</span>
        <span class="choiceTag danger">오류</span>
      `;
            btn.addEventListener("click", () => startNewGame());
            elChoices.appendChild(btn);
            return;
        }

        for (const c of safeArr) {
            const id = c?.id;
            const text = safeText(c?.text);
            const tags = Array.isArray(c?.tags) ? c.tags : [];
            const tag = tags[0] ? String(tags[0]) : "choice";

            const btn = document.createElement("button");
            btn.className = "choiceBtn";
            btn.type = "button";
            btn.dataset.choice = String(id);

            const danger = tag === "risk" || tag === "mystery";
            btn.innerHTML = `
        <span class="choiceId">${safeText(id)}</span>
        <span class="choiceText">${escapeHtml(text)}</span>
        <span class="choiceTag ${danger ? "danger" : ""}">${escapeHtml(tag)}</span>
      `;

            btn.addEventListener("click", () => onChoose(id));
            elChoices.appendChild(btn);
        }
    }

    function escapeHtml(s) {
        return String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    // ===== Client “state” accumulation =====
    // /api/story.js 는 body.state 를 “프론트에서 저장한 전체 상태(JSON)”로 받음.
    // 여기서는 최소한으로:
    // - lastScene 요약
    // - stats
    // - relationships 변화 누적
    // - globalFlags 누적
    // 을 유지해서 서버에 전달.
    function persistClientState(scene) {
        const patch = scene?.statePatch || {};
        const stats = patch?.stats || {};
        const rels = Array.isArray(patch?.relationships) ? patch.relationships : [];
        const addFlags = Array.isArray(patch?.globalFlagsAdd) ? patch.globalFlagsAdd : [];
        const removeFlags = Array.isArray(patch?.globalFlagsRemove) ? patch.globalFlagsRemove : [];

        const current = runtime.state || loadSave()?.state || makeEmptyClientState();

        // stats: 현재값처럼 취급
        current.stats = {
            focus: stats.focus ?? current.stats.focus ?? 0,
            talent: stats.talent ?? current.stats.talent ?? 0,
            reason: stats.reason ?? current.stats.reason ?? 0,
            bond: stats.bond ?? current.stats.bond ?? 0,
        };

        // relationships: 누적 델타(정수)
        for (const r of rels) {
            const name = safeText(r?.name);
            if (!name) continue;

            if (!current.relationships[name]) {
                current.relationships[name] = {
                    friendship: 0,
                    trust: 0,
                    romance: 0,
                    flags: [],
                };
            }
            const slot = current.relationships[name];
            slot.friendship += Number(r.friendshipDelta ?? 0) || 0;
            slot.trust += Number(r.trustDelta ?? 0) || 0;
            slot.romance += Number(r.romanceDelta ?? 0) || 0;

            const fAdd = Array.isArray(r.flagsAdd) ? r.flagsAdd : [];
            const fRem = Array.isArray(r.flagsRemove) ? r.flagsRemove : [];
            for (const f of fAdd) if (!slot.flags.includes(f)) slot.flags.push(f);
            for (const f of fRem) slot.flags = slot.flags.filter((x) => x !== f);
        }

        // global flags
        for (const f of addFlags) if (!current.globalFlags.includes(f)) current.globalFlags.push(f);
        for (const f of removeFlags) current.globalFlags = current.globalFlags.filter((x) => x !== f);

        // last meta
        current.last = {
            chapter: scene?.chapter || null,
            gmNotes: scene?.gmNotes || null,
        };

        runtime.state = current;

        // save
        saveGame({
            updatedAt: Date.now(),
            state: current,
            lastScene: scene,
        });
    }

    function makeEmptyClientState() {
        return {
            stats: { focus: 0, talent: 0, reason: 0, bond: 0 },
            relationships: {}, // name -> { friendship, trust, romance, flags[] }
            globalFlags: [],
            last: null,
        };
    }

    // ===== API calls =====
    async function callStoryAPI({ state, choiceId = null, userText = "" }) {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state, choiceId, userText }),
        });

        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const msg = data?.error || `HTTP ${res.status}`;
            throw new Error(msg);
        }

        // 서버가 JSON 파싱 실패 시 { error, raw } 형태로 줄 수 있음
        if (data?.error && data?.raw) {
            // raw 텍스트를 표시하진 않고, 사용자에게만 알림
            throw new Error("Model output was not valid JSON. (Check server logs/raw)");
        }

        return data;
    }

    // ===== User actions =====
    async function startNewGame() {
        if (runtime.isBusy) return;

        setBusy(true);
        try {
            runtime.state = makeEmptyClientState();
            saveGame({ updatedAt: Date.now(), state: runtime.state, lastScene: null });

            const scene = await callStoryAPI({ state: runtime.state, choiceId: null, userText: "" });
            renderScene(scene);
            showToast("새 게임 시작");
        } catch (e) {
            console.error(e);
            showToast(`시작 실패: ${e.message || e}`);
            // fallback UI
            setBusy(false);
        }
    }

    async function onChoose(choiceId) {
        if (runtime.isBusy) return;

        // 페이지가 남아있다면 먼저 페이지 넘김을 유도
        if (runtime.pageIndex < runtime.pages.length - 1) {
            renderPage(runtime.pageIndex + 1);
            return;
        }

        setBusy(true);
        try {
            const scene = await callStoryAPI({
                state: runtime.state,
                choiceId,
                userText: "",
            });
            renderScene(scene);
        } catch (e) {
            console.error(e);
            showToast(`오류: ${e.message || e}`);
            setBusy(false);
        }
    }

    function onNextHint() {
        if (runtime.isBusy) return;
        if (runtime.pageIndex < runtime.pages.length - 1) {
            renderPage(runtime.pageIndex + 1);
        }
    }

    // ===== Boot =====
    function boot() {
        // nextHint tap
        elNextHint.addEventListener("click", onNextHint);

        // 대사창 탭해도 다음 페이지로
        // (스크롤 없는 UX를 위해)
        const card = document.querySelector(".dialogueCard");
        if (card) {
            card.addEventListener("click", (e) => {
                // 선택지 버튼 클릭은 제외
                if (e.target.closest(".choiceBtn")) return;
                onNextHint();
            });
        }

        // 이어하기
        const save = loadSave();
        if (save?.lastScene) {
            runtime.state = save.state || makeEmptyClientState();
            renderScene(save.lastScene);
            showToast("이어하기");
            return;
        }

        // 저장이 없으면 자동 시작
        startNewGame();
    }

    // expose (디버깅용)
    window.TRPG = {
        startNewGame,
        clearSave: () => {
            localStorage.removeItem(LS_KEY);
            showToast("세이브 삭제");
        },
        getState: () => runtime.state,
    };

    boot();
})();
