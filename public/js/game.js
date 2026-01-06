/* /public/js/game.js
   모바일 TRPG 클라이언트 렌더러 (Gemini /api/story.js 응답 JSON 스키마 기반)
   - 스크롤 없이(overflow hidden) "페이지 넘김" 방식으로 narration+dialogue를 표시
   - choice 클릭 -> /api/story POST -> 다음 JSON 렌더
   - state를 localStorage에 저장(이어하기)
   - ✅ storyLog(최근 장면 기록) 누적으로 이야기 연결 강화
*/

(() => {
  const API_URL = "/api/story"; // Vercel serverless function 경로
  const LS_KEY = "ariel_trpg_save_v2"; // 버전 올려서 기존 세이브 충돌 방지

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

  const elNarration = document.getElementById("narration");
  const elDialogueList = document.getElementById("dialogueList");
  const elChoices = document.getElementById("choices");
  const elNextHint = document.getElementById("nextHint");

  // ===== Runtime =====
  const runtime = {
    state: null,      // 서버로 보내는 state(프론트 저장 상태)
    lastScene: null,  // 마지막으로 받은 GM JSON
    pageIndex: 0,
    pages: [],        // [{ narration, dialogue[] }]
    isBusy: false,
  };

  // ===== Utilities =====
  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function safeText(v) {
    if (v == null) return "";
    return String(v);
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setBusy(b) {
    runtime.isBusy = b;
    document.body.style.cursor = b ? "progress" : "";
    // 선택지 disable
    const btns = elChoices ? elChoices.querySelectorAll("button") : [];
    btns.forEach((btn) => (btn.disabled = b));
    // next hint
    if (elNextHint) {
      elNextHint.disabled = b;
      elNextHint.style.opacity = b ? "0.6" : "1";
    }
  }

  function showToast(msg) {
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

  function buildCharPath(id, expression) {
    const safeId = encodeURIComponent(id || "unknown");
    const safeEx = encodeURIComponent(expression || "neutral");
    return `/img/chars/${safeId}/${safeEx}.png`;
  }

  function buildBgPath(bgKey) {
    const key = encodeURIComponent(bgKey || "");
    if (!key) return null;
    return `/img/bg/${key}.jpg`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ===== State structure =====
  function makeEmptyClientState() {
    return {
      stats: { focus: 0, talent: 0, reason: 0, bond: 0 },
      relationships: {}, // name -> { friendship, trust, romance, flags[] }
      globalFlags: [],
      last: null,

      // ✅ 이야기 연결용 최근 장면 로그
      // server에 그대로 보내서 모델이 참고하게 만들기
      storyLog: [],
    };
  }

  // ===== Term =====
  function termToKo(term) {
    switch (term) {
      case "Fall": return "가을";
      case "Winter": return "겨울";
      case "Spring": return "봄";
      case "Summer": return "여름";
      default: return safeText(term);
    }
  }

  // ===== Dialogue rendering =====
  function renderDialogueLines(lines) {
    if (!elDialogueList) return;

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

  // ===== Pagination without scroll =====
  function splitNarration(text) {
    const t = safeText(text).replace(/\s+/g, " ").trim();
    if (!t) return [];
    const parts = t
      .split(/(?<=[\.\?\!…])\s+/g)
      .map((s) => s.trim())
      .filter(Boolean);

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

  function isOverflowingTextArea() {
    // narration은 line-clamp라 판정이 애매할 수 있어도
    // dialogueList max-height + overflow hidden 기반으로 안정 판정
    const diaOverflow = elDialogueList
      ? elDialogueList.scrollHeight > elDialogueList.clientHeight + 1
      : false;

    const narOverflow = elNarration
      ? elNarration.scrollHeight > elNarration.clientHeight + 1
      : false;

    return diaOverflow || narOverflow;
  }

  function createPages(scene) {
    const narration = safeText(scene?.narration);
    const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];

    const dialogueLines = dialogue.map((d) => ({
      speaker: safeText(d?.speaker),
      text: safeText(d?.text),
    }));

    const narrationParts = splitNarration(narration);

    const pages = [];

    // 측정 위해 임시 렌더
    if (elDialogueList) clearChildren(elDialogueList);

    let nIdx = 0;
    let dIdx = 0;

    while (nIdx < narrationParts.length || dIdx < dialogueLines.length) {
      let pageNarr = "";
      const pageDia = [];

      // narration 적재
      while (nIdx < narrationParts.length) {
        const candidate = pageNarr ? pageNarr + " " + narrationParts[nIdx] : narrationParts[nIdx];

        if (elNarration) elNarration.textContent = candidate;
        renderDialogueLines(pageDia);

        if (isOverflowingTextArea()) break;

        pageNarr = candidate;
        nIdx++;
      }

      // dialogue 적재
      while (dIdx < dialogueLines.length) {
        pageDia.push(dialogueLines[dIdx]);

        if (elNarration) elNarration.textContent = pageNarr || " ";
        renderDialogueLines(pageDia);

        if (isOverflowingTextArea()) {
          pageDia.pop();
          break;
        }
        dIdx++;
      }

      // 안전장치
      if (!pageNarr && pageDia.length === 0) {
        if (nIdx < narrationParts.length) pageNarr = narrationParts[nIdx++];
        else if (dIdx < dialogueLines.length) pageDia.push(dialogueLines[dIdx++]);
      }

      pages.push({ narration: pageNarr.trim(), dialogue: pageDia });
    }

    if (pages.length === 0) pages.push({ narration, dialogue: dialogueLines });

    return pages;
  }

  function renderPage(idx) {
    if (!runtime.pages.length) return;

    idx = clamp(idx, 0, runtime.pages.length - 1);
    runtime.pageIndex = idx;

    const p = runtime.pages[idx] || { narration: "", dialogue: [] };

    if (elNarration) elNarration.textContent = p.narration || "";
    renderDialogueLines(p.dialogue || []);

    const hasNext = runtime.pageIndex < runtime.pages.length - 1;
    if (elNextHint) elNextHint.style.display = hasNext ? "inline-flex" : "none";
  }

  // ===== Visuals =====
  function applyVisuals(visuals) {
    const bgKey = safeText(visuals?.bgKey);
    const bgPath = buildBgPath(bgKey);

    if (bgPath && elBg) {
      // 로드 실패 대비
      const img = new Image();
      img.onload = () => (elBg.style.backgroundImage = `url("${bgPath}")`);
      img.onerror = () => {
        // fallback: 기본 그라데이션
        elBg.style.backgroundImage = "";
      };
      img.src = bgPath;
    }

    const chars = Array.isArray(visuals?.characters) ? visuals.characters : [];
    const spotlightId = safeText(visuals?.spotlight);

    // 아바타: ariel 우선, 없으면 spotlight, 없으면 첫번째
    const ariel = chars.find((c) => c?.id === "ariel");
    const spot = chars.find((c) => c?.id === spotlightId);
    const pick = ariel || spot || chars[0];

    if (elAvatarImg) {
      if (pick?.id) {
        elAvatarImg.src = buildCharPath(pick.id, pick.expression || "neutral");
        elAvatarImg.alt = pick.id;
      } else {
        elAvatarImg.src = buildCharPath("ariel", "neutral");
        elAvatarImg.alt = "ariel";
      }
    }
  }

  // ===== Choices =====
  function renderChoices(choices) {
    if (!elChoices) return;

    clearChildren(elChoices);

    const arr = Array.isArray(choices) ? choices : [];
    const safeArr = arr.slice(0, 3);

    if (safeArr.length === 0) {
      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.type = "button";
      btn.innerHTML = `
        <span class="choiceId">!</span>
        <span class="choiceText">선택지가 없습니다. (새로 시작)</span>
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

      const danger = tag === "risk" || tag === "mystery";

      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.type = "button";
      btn.dataset.choice = String(id);

      btn.innerHTML = `
        <span class="choiceId">${escapeHtml(id)}</span>
        <span class="choiceText">${escapeHtml(text)}</span>
        <span class="choiceTag ${danger ? "danger" : ""}">${escapeHtml(tag)}</span>
      `;

      btn.addEventListener("click", () => onChoose(id));
      elChoices.appendChild(btn);
    }
  }

  // ===== Scene render =====
  function renderScene(scene) {
    runtime.lastScene = scene;

    const ch = scene?.chapter || {};
    const year = ch.schoolYear != null ? `${ch.schoolYear}학년` : "";
    const term = ch.term ? termToKo(ch.term) : "";

    if (elArcTitle) elArcTitle.textContent = [year, term].filter(Boolean).join(" ") || safeText(ch.arcTitle) || "진행 중";
    if (elSceneTitle) elSceneTitle.textContent = safeText(ch.sceneTitle || ch.arcTitle || "장면");
    if (elLocation) elLocation.textContent = safeText(ch.location || "");
    if (elTime) elTime.textContent = safeText(ch.time || "");

    // stats (statePatch.stats는 현재값처럼 쓰는 형태라 그대로 표시)
    const sp = scene?.statePatch?.stats || {};
    if (elStatFocus) elStatFocus.textContent = String(sp.focus ?? 0);
    if (elStatTalent) elStatTalent.textContent = String(sp.talent ?? 0);
    if (elStatReason) elStatReason.textContent = String(sp.reason ?? 0);
    if (elStatBond) elStatBond.textContent = String(sp.bond ?? 0);

    applyVisuals(scene?.visuals);

    // 페이지 생성(레이아웃 측정 포함)
    setBusy(true);
    requestAnimationFrame(() => {
      runtime.pages = createPages(scene);
      runtime.pageIndex = 0;
      renderPage(0);
      renderChoices(scene?.choices);
      setBusy(false);

      // state 누적 저장
      persistClientState(scene);
    });
  }

  // ===== API =====
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

    if (data?.error && data?.raw) {
      throw new Error("Model output was not valid JSON. (server returned raw)");
    }

    return data;
  }

  // ===== State accumulation =====
  function ensureState() {
    if (!runtime.state) runtime.state = makeEmptyClientState();
    if (!Array.isArray(runtime.state.storyLog)) runtime.state.storyLog = [];
  }

  function persistClientState(scene) {
    ensureState();

    const patch = scene?.statePatch || {};
    const stats = patch?.stats || {};
    const rels = Array.isArray(patch?.relationships) ? patch.relationships : [];
    const addFlags = Array.isArray(patch?.globalFlagsAdd) ? patch.globalFlagsAdd : [];
    const removeFlags = Array.isArray(patch?.globalFlagsRemove) ? patch.globalFlagsRemove : [];

    // stats (현재값)
    runtime.state.stats = {
      focus: stats.focus ?? runtime.state.stats.focus ?? 0,
      talent: stats.talent ?? runtime.state.stats.talent ?? 0,
      reason: stats.reason ?? runtime.state.stats.reason ?? 0,
      bond: stats.bond ?? runtime.state.stats.bond ?? 0,
    };

    // relationships (누적)
    for (const r of rels) {
      const name = safeText(r?.name);
      if (!name) continue;

      if (!runtime.state.relationships[name]) {
        runtime.state.relationships[name] = {
          friendship: 0,
          trust: 0,
          romance: 0,
          flags: [],
        };
      }
      const slot = runtime.state.relationships[name];
      slot.friendship += Number(r.friendshipDelta ?? 0) || 0;
      slot.trust += Number(r.trustDelta ?? 0) || 0;
      slot.romance += Number(r.romanceDelta ?? 0) || 0;

      const fAdd = Array.isArray(r.flagsAdd) ? r.flagsAdd : [];
      const fRem = Array.isArray(r.flagsRemove) ? r.flagsRemove : [];
      for (const f of fAdd) if (!slot.flags.includes(f)) slot.flags.push(f);
      for (const f of fRem) slot.flags = slot.flags.filter((x) => x !== f);
    }

    // global flags
    for (const f of addFlags) if (!runtime.state.globalFlags.includes(f)) runtime.state.globalFlags.push(f);
    for (const f of removeFlags) runtime.state.globalFlags = runtime.state.globalFlags.filter((x) => x !== f);

    // last meta
    runtime.state.last = {
      chapter: scene?.chapter || null,
      gmNotes: scene?.gmNotes || null,
    };

    // ✅ storyLog 추가(최근 6개 유지)
    const chapter = scene?.chapter || {};
    const firstDialogue = Array.isArray(scene?.dialogue) ? scene.dialogue.slice(0, 3) : [];
    const logItem = {
      t: Date.now(),
      chapter: {
        schoolYear: chapter.schoolYear ?? null,
        term: chapter.term ?? null,
        arcTitle: chapter.arcTitle ?? null,
        sceneTitle: chapter.sceneTitle ?? null,
        location: chapter.location ?? null,
        time: chapter.time ?? null,
      },
      narration: safeText(scene?.narration).slice(0, 600),
      dialogue: firstDialogue.map((d) => ({
        speaker: safeText(d?.speaker).slice(0, 20),
        text: safeText(d?.text).slice(0, 160),
      })),
      chosen: null,
    };

    runtime.state.storyLog.push(logItem);
    runtime.state.storyLog = runtime.state.storyLog.slice(-6);

    // save
    saveGame({
      updatedAt: Date.now(),
      state: runtime.state,
      lastScene: scene,
    });
  }

  // ===== Actions =====
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
      setBusy(false);
    }
  }

  async function onChoose(choiceId) {
    if (runtime.isBusy) return;

    // 페이지가 남아있으면 우선 페이지 넘김
    if (runtime.pageIndex < runtime.pages.length - 1) {
      renderPage(runtime.pageIndex + 1);
      return;
    }

    ensureState();

    // ✅ 직전 로그에 선택 기록 (이게 이어지게 만드는 핵심)
    if (runtime.state.storyLog.length) {
      runtime.state.storyLog[runtime.state.storyLog.length - 1].chosen = Number(choiceId);
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
    if (elNextHint) elNextHint.addEventListener("click", onNextHint);

    // 대사창 탭도 다음(선택지 제외)
    const card = document.querySelector(".dialogueCard");
    if (card) {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".choiceBtn")) return;
        onNextHint();
      });
    }

    // 이어하기
    const save = loadSave();
    if (save?.lastScene && save?.state) {
      runtime.state = save.state;
      renderScene(save.lastScene);
      showToast("이어하기");
      return;
    }

    // 없으면 자동 시작
    startNewGame();
  }

  // ===== Debug helpers =====
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
