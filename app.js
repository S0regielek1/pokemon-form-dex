// 姿違い対応ポケモン図鑑の画面。絞り込み・集計・候補の計算は lib/dexcore.js（純関数）に任せ、
// ここでは状態の保持と DOM の描画だけを行う。
(function () {
  "use strict";

  const data = window.DEX_DATA;
  const searchIndex = window.DEX_SEARCH_INDEX;
  const core = window.DexCore;
  const $ = (id) => document.getElementById(id);

  if (!data || !searchIndex || !core) {
    const error = $("error");
    error.hidden = false;
    error.textContent = "データを読み込めませんでした。data/generated/dex-data.js と search-index.js があるか確認してください。";
    $("summary-main").textContent = "";
    return;
  }

  const UNKNOWN_IMAGE = "assets/unknown.png";
  const STAT_KEYS = data.meta.statKeys;
  const TARGET_PREVIEW = 30;
  const TARGET_PREVIEW_NARROW = 8;
  const SUGGEST_LIMIT = 10;
  const COMPOSE_GUARD_MS = 30;
  const OVERSCAN_ROWS = 12;   // 見えている範囲の上下に余分に描画しておく行数
  const COLUMN_COUNT = 12;
  const TYPE_CLASS = {
    "ノーマル": "normal", "ほのお": "fire", "みず": "water", "でんき": "electric", "くさ": "grass",
    "こおり": "ice", "かくとう": "fighting", "どく": "poison", "じめん": "ground", "ひこう": "flying",
    "エスパー": "psychic", "むし": "bug", "いわ": "rock", "ゴースト": "ghost", "ドラゴン": "dragon",
    "あく": "dark", "はがね": "steel", "フェアリー": "fairy",
  };
  // 行に毎回出すと煩雑なタグ（代表・採用は既定の状態なので行には出さない）。
  const QUIET_TAGS = new Set(["rep", "included"]);
  const IMAGE_STATE_LABEL = { confirmed: "対応確認済み", substitute: "代用（原種の画像）", none: "なし（要確認）", absent: "なし（取得元に画像が無い）" };

  const entries = data.entries;
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const tagById = new Map(data.tags.map((tag) => [tag.id, tag]));
  const usedTags = new Set();
  entries.forEach((entry) => entry.tags.forEach((tagId) => usedTags.add(tagId)));
  // 要確認の姿が1件も無いときは、要確認に関する表示（切り替え・内訳・確認状態のタグ）を出さない。
  // データを作り直して要確認の姿が出てきたら、自動で表示が戻る。
  const hasReview = entries.some((entry) => entry.status === "needs_review");
  const hasStatusFlags = hasReview || usedTags.has("img_check") || usedTags.has("name_check");
  $("show-review").parentElement.hidden = !hasReview;

  const state = {
    cond: core.createCondition(),
    condLabel: "",          // 種・姿・番号の候補を選んだときの表示名
    allForms: false,
    open: new Set(),        // 手動で開いている種の全国番号
    suggestion: null,       // 直近の候補（core.suggest の戻り値）
    flatItems: [],          // 候補を上から順に並べた配列（キーボード操作用）
    activeIndex: -1,
    composing: false,       // 日本語入力の変換中か
    composedAt: 0,          // 直近に変換を確定した時刻（確定に使った Enter を候補の決定にしないため）
    showAllTargets: false,
    showParents: false,     // 条件に合わない親（所属を示す見出し）を表に出すか
    matched: [],            // 直近の検索結果
    rows: [],               // 表に出す全行（画面には見えている範囲だけ描画する）
    windowStart: -1,        // いま描画している行の範囲
    windowEnd: -1,
    detailId: null,
    lastFocus: null,
  };

  const input = $("search-input");

  // スマホ幅では検索欄の例を短くする（長い例は途中で切れるため）。短い例は HTML の data-placeholder-short に書く。
  const placeholderLong = input.getAttribute("placeholder");
  const placeholderShort = input.dataset.placeholderShort;
  if (placeholderShort) {
    const narrowScreen = window.matchMedia("(max-width: 720px)");
    const applyPlaceholder = () => input.setAttribute("placeholder", narrowScreen.matches ? placeholderShort : placeholderLong);
    applyPlaceholder();
    narrowScreen.addEventListener("change", applyPlaceholder);
  }
  const suggestList = $("suggest-list");

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
    ));
  }

  function imageTag(entry, size) {
    const src = entry.img || UNKNOWN_IMAGE;
    return `<img loading="lazy" width="${size}" height="${size}" src="${escapeHtml(src)}" alt="" data-fallback="1">`;
  }

  // 画像が読めないときは不明画像に差し替える（一覧のレイアウトは崩さない）。
  document.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.dataset.fallback === "1") {
      target.dataset.fallback = "0";
      target.src = UNKNOWN_IMAGE;
    }
  }, true);

  // ---------- 予測変換 ----------

  /** 候補の文字のうち、入力と一致した部分を強調する。 */
  function highlight(label, query) {
    // ひらがな→カタカナは1文字ずつの置き換えなので、位置はずれない。
    // NFKC で長さが変わる候補名は、位置がずれるため強調しない。
    const fold = (value) => value.normalize("NFKC").toLowerCase()
      .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
    const needle = fold(query).trim();
    const haystack = fold(label);
    const at = needle && haystack.length === label.length ? haystack.indexOf(needle) : -1;
    if (at < 0) return escapeHtml(label);
    return escapeHtml(label.slice(0, at)) + "<mark>" + escapeHtml(label.slice(at, at + needle.length)) + "</mark>"
      + escapeHtml(label.slice(at + needle.length));
  }

  function closeSuggest() {
    suggestList.hidden = true;
    suggestList.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    state.flatItems = [];
    state.activeIndex = -1;
  }

  function renderSuggest() {
    const query = input.value;
    const result = core.suggest(searchIndex, entries, state.cond, query, SUGGEST_LIMIT);
    state.suggestion = result;
    state.flatItems = [];
    state.activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    if (core.normalizeText(query) === "" && core.parseDexNumber(query) === null) {
      closeSuggest();
      return;
    }
    const parts = [];
    // 最も順位の良い候補を含む種類を上に出す。画面の一番上が「最上位の候補」になり、Enter で選ばれる。
    const bestRank = (group) => Math.min(...group.items.map((item) => item.rank));
    const groups = result.groups.slice().sort((a, b) => bestRank(a) - bestRank(b));
    groups.forEach((group) => {
      parts.push(`<div class="suggest-group-title" role="presentation">${escapeHtml(group.title)}</div>`);
      group.items.forEach((item) => {
        const index = state.flatItems.length;
        state.flatItems.push(item);
        const image = item.kind === "entry"
          ? `<img loading="lazy" width="32" height="32" src="${escapeHtml(item.img || UNKNOWN_IMAGE)}" alt="" data-fallback="1">`
          : "";
        const sub = item.sub ? `<span class="suggest-sub">${highlight(item.sub, query)}</span>` : "";
        parts.push(
          `<div class="suggest-item" role="option" id="suggest-${index}" data-index="${index}" aria-selected="false">`
          + `${image}<span class="suggest-text">${highlight(item.label, query)}${sub}</span>`
          + `<span class="suggest-count">${item.count}姿</span></div>`
        );
      });
    });
    if (result.more > 0) {
      parts.push(`<div class="suggest-more" role="presentation">ほか${result.more}件。文字を足すと絞れます。</div>`);
    }
    if (state.flatItems.length === 0) {
      parts.push('<div class="suggest-empty" role="presentation">候補はありません。Enter で、入力した文字を含む姿を検索します。</div>');
    }
    suggestList.innerHTML = parts.join("");
    suggestList.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function setActive(index) {
    const count = state.flatItems.length;
    if (count === 0) return;
    state.activeIndex = (index + count) % count;
    suggestList.querySelectorAll(".suggest-item").forEach((node) => {
      const active = Number(node.dataset.index) === state.activeIndex;
      node.classList.toggle("active", active);
      node.setAttribute("aria-selected", active ? "true" : "false");
      if (active) {
        node.scrollIntoView({ block: "nearest" });
        input.setAttribute("aria-activedescendant", node.id);
      }
    });
  }

  function chooseSuggestion(item) {
    if (item.kind === "species" || item.kind === "number") {
      state.cond.speciesNo = item.ref;
      state.cond.entryId = null;
      state.cond.text = "";
      state.condLabel = item.label;
    } else if (item.kind === "entry") {
      state.cond.entryId = item.ref;
      state.cond.speciesNo = null;
      state.cond.text = "";
      state.condLabel = entryById.get(item.ref).name;
    } else if (item.kind === "tag") {
      const group = tagById.get(item.ref).group;
      const selected = state.cond.tags[group] || [];
      if (!selected.includes(item.ref)) setTagState(item.ref, "include");
    } else if (item.kind === "type") {
      if (!state.cond.types.includes(item.ref)) state.cond.types = state.cond.types.concat(item.ref);
    }
    input.value = "";
    closeSuggest();
    render();
  }

  /** 候補を選ばずに確定したとき。最上位の候補があればそれを選び、無ければ部分一致で検索する。 */
  function commitInput() {
    if (state.activeIndex >= 0) {
      chooseSuggestion(state.flatItems[state.activeIndex]);
      return;
    }
    if (state.flatItems.length > 0) {
      chooseSuggestion(state.flatItems[0]);
      return;
    }
    const text = input.value.trim();
    if (text === "") return;
    state.cond.text = text;
    state.cond.speciesNo = null;
    state.cond.entryId = null;
    state.condLabel = "";
    input.value = "";
    closeSuggest();
    render();
  }

  input.addEventListener("compositionstart", () => { state.composing = true; });
  input.addEventListener("compositionend", () => {
    state.composing = false;
    state.composedAt = performance.now();
    renderSuggest();
  });
  input.addEventListener("input", renderSuggest);
  input.addEventListener("focus", () => { if (input.value) renderSuggest(); });
  input.addEventListener("keydown", (event) => {
    // 変換の確定に使う Enter は、候補の決定として扱わない。
    // ブラウザによっては compositionend が keydown より先に来るため、確定の直後も変換中として扱う。
    const composing = state.composing || event.isComposing || event.keyCode === 229
      || performance.now() - state.composedAt < COMPOSE_GUARD_MS;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (composing) return;
      if (suggestList.hidden) renderSuggest();
      event.preventDefault();
      if (state.activeIndex < 0) setActive(event.key === "ArrowDown" ? 0 : state.flatItems.length - 1);
      else setActive(state.activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      if (composing) return;
      event.preventDefault();
      commitInput();
    } else if (event.key === "Escape") {
      if (!suggestList.hidden) {
        event.stopPropagation();
        closeSuggest();
      }
    }
  });
  suggestList.addEventListener("mousedown", (event) => event.preventDefault());
  suggestList.addEventListener("click", (event) => {
    const node = event.target.closest(".suggest-item");
    if (node) chooseSuggestion(state.flatItems[Number(node.dataset.index)]);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-box")) closeSuggest();
  });

  // ---------- 条件の表示とフィルター ----------

  function renderConditions() {
    const chips = [];
    const cond = state.cond;
    if (cond.speciesNo !== null) chips.push({ key: "species", value: "", text: `種: ${state.condLabel}` });
    if (cond.entryId !== null) chips.push({ key: "entry", value: "", text: `姿: ${state.condLabel}` });
    if (cond.text) chips.push({ key: "text", value: "", text: `「${cond.text}」を含む` });
    cond.types.forEach((type) => chips.push({ key: "type", value: type, text: `タイプ: ${type}` }));
    Object.keys(cond.tags).forEach((group) => {
      cond.tags[group].forEach((tagId) => chips.push({ key: "tag", value: tagId, text: tagById.get(tagId).label }));
    });
    cond.excludeTags.forEach((tagId) => chips.push({
      key: "tag", value: tagId, text: `除外: ${tagById.get(tagId).label}`, exclude: true,
    }));
    $("active-conditions").innerHTML = chips.map((chip) => (
      `<span class="cond-chip${chip.exclude ? " exclude" : ""}">${escapeHtml(chip.text)}`
      + `<button type="button" data-clear="${chip.key}" data-value="${escapeHtml(chip.value)}" `
      + `aria-label="${escapeHtml(chip.text)} の条件を外す">×</button></span>`
    )).join("");
  }

  function toggleType(type) {
    state.cond.types = state.cond.types.includes(type)
      ? state.cond.types.filter((value) => value !== type)
      : state.cond.types.concat(type);
  }

  /** タグの状態を返す: "include"（このタグで絞る）/ "exclude"（このタグを除外）/ "off"。 */
  function tagState(tagId) {
    const tag = tagById.get(tagId);
    if ((state.cond.tags[tag.group] || []).includes(tagId)) return "include";
    return state.cond.excludeTags.includes(tagId) ? "exclude" : "off";
  }

  function setTagState(tagId, next) {
    const tag = tagById.get(tagId);
    state.cond.tags[tag.group] = (state.cond.tags[tag.group] || []).filter((value) => value !== tagId);
    state.cond.excludeTags = state.cond.excludeTags.filter((value) => value !== tagId);
    if (next === "include") state.cond.tags[tag.group] = state.cond.tags[tag.group].concat(tagId);
    if (next === "exclude") state.cond.excludeTags = state.cond.excludeTags.concat(tagId);
  }

  /** タグのボタンを押すたびに、絞り込む → 除外する → 解除、の順に切り替える。 */
  function cycleTag(tagId) {
    const order = { off: "include", include: "exclude", exclude: "off" };
    setTagState(tagId, order[tagState(tagId)]);
  }

  $("active-conditions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-clear]");
    if (!button) return;
    const key = button.dataset.clear;
    if (key === "species" || key === "entry") {
      state.cond.speciesNo = null;
      state.cond.entryId = null;
      state.condLabel = "";
    }
    if (key === "text") state.cond.text = "";
    if (key === "type") toggleType(button.dataset.value);
    if (key === "tag") setTagState(button.dataset.value, "off");
    render();
    input.focus();
  });

  function renderFilters() {
    const typeCount = core.typeCounts(entries, state.cond, data.types);
    $("type-chips").innerHTML = data.types.map((type) => {
      const pressed = state.cond.types.includes(type);
      return `<button type="button" class="chip${typeCount[type] === 0 ? " zero" : ""}" data-type="${escapeHtml(type)}" `
        + `aria-pressed="${pressed}">${escapeHtml(type)}<span class="count">${typeCount[type]}</span></button>`;
    }).join("");

    const tagCount = core.facetCounts(entries, state.cond, data.tags);
    $("tag-filters").innerHTML = data.tagGroups.map((group) => {
      const tags = data.tags.filter((tag) => tag.group === group.id && usedTags.has(tag.id));
      if (tags.length === 0 || (group.id === "status" && !hasStatusFlags)) return "";
      const chips = tags.map((tag) => {
        const current = tagState(tag.id);
        const hint = { off: "押すと、このタグで絞り込みます", include: "絞り込み中。もう一度押すと除外します", exclude: "除外中。もう一度押すと解除します" }[current];
        return `<button type="button" class="chip${tagCount[tag.id] === 0 ? " zero" : ""}${current === "exclude" ? " exclude" : ""}" `
          + `data-tag="${tag.id}" data-state="${current}" aria-pressed="${current === "include"}" title="${hint}" `
          + `aria-label="${escapeHtml(tag.label)}（${hint}）">${current === "exclude" ? "除外 " : ""}${escapeHtml(tag.label)}`
          + `<span class="count">${tagCount[tag.id]}</span></button>`;
      }).join("");
      return `<div class="filter-group"><div class="filter-title">${escapeHtml(group.label)}</div>`
        + `<div class="chips" role="group" aria-label="${escapeHtml(group.label)}で絞り込み">${chips}</div></div>`;
    }).join("");
  }

  $("type-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-type]");
    if (!chip) return;
    toggleType(chip.dataset.type);
    render();
  });
  $("tag-filters").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-tag]");
    if (!chip) return;
    cycleTag(chip.dataset.tag);
    render();
  });
  document.querySelectorAll('input[name="type-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        state.cond.typeMode = radio.value;
        render();
      }
    });
  });
  $("all-forms").addEventListener("change", (event) => { state.allForms = event.target.checked; render(); });
  $("show-parents").addEventListener("change", (event) => { state.showParents = event.target.checked; render(); });
  $("show-review").addEventListener("change", (event) => {
    state.cond.showNeedsReview = event.target.checked;
    render();
  });

  function resetAll() {
    state.cond = core.createCondition();
    state.condLabel = "";
    state.allForms = false;
    state.open = new Set();
    state.showAllTargets = false;
    input.value = "";
    $("all-forms").checked = false;
    $("show-review").checked = true;
    state.showParents = false;
    $("show-parents").checked = false;
    document.querySelector('input[name="type-mode"][value="any"]').checked = true;
    closeSuggest();
    render();
  }
  $("reset-all").addEventListener("click", resetAll);
  $("empty-reset").addEventListener("click", resetAll);

  // ---------- 件数・対象一覧・表 ----------

  function renderSummary(matched, rows, filtering) {
    const summary = core.summarize(matched);
    $("summary-main").innerHTML =
      `対象 <strong>${summary.species}</strong>種 ｜ 一致する姿 <strong>${summary.forms}</strong>件`
      + (hasReview ? `（採用${summary.included}・要確認${summary.needsReview}）` : "");
    $("summary-compact").innerHTML =
      `対象 <strong>${summary.species}</strong>種・一致する姿 <strong>${summary.forms}</strong>件`;
    $("summary-sub").textContent =
      `内訳: 原種${summary.reps}件・追加の姿違い${summary.extras}件 ／ 表示${rows.length}行`
      + (filtering && state.showParents ? "（条件に合わない親は見出しとして表示し、件数には含めません）" : "");

    // 絞り込んでいないときは表がそのまま全件の一覧なので、対象一覧は出さない（表まで遠くならないように）。
    if (!filtering) {
      $("target-list").innerHTML = "";
      return;
    }
    const preview = window.matchMedia("(max-width: 720px)").matches ? TARGET_PREVIEW_NARROW : TARGET_PREVIEW;
    const shown = state.showAllTargets ? matched : matched.slice(0, preview);
    const items = shown.map((entry) => (
      `<button type="button" class="target-item" data-detail="${escapeHtml(entry.id)}">`
      + `${imageTag(entry, 28)}<span>${escapeHtml(entry.name)}</span></button>`
    ));
    if (matched.length > preview) {
      items.push(`<button type="button" class="secondary-button target-more" id="target-more">`
        + (state.showAllTargets ? "先頭だけ表示" : `すべて見る（全${matched.length}件）`) + "</button>");
    }
    $("target-list").innerHTML = items.join("");
  }

  $("target-list").addEventListener("click", (event) => {
    if (event.target.closest("#target-more")) {
      state.showAllTargets = !state.showAllTargets;
      render();
      return;
    }
    const item = event.target.closest("[data-detail]");
    if (item) openDetail(item.dataset.detail, item);
  });

  function typeBadges(types) {
    return types.map((type) => (
      `<span class="type-badge type-${TYPE_CLASS[type] || "other"}">${escapeHtml(type)}</span>`
    )).join("");
  }

  function tagBadges(entry) {
    return entry.tags.filter((tagId) => !QUIET_TAGS.has(tagId) && tagById.has(tagId)).map((tagId) => (
      `<span class="tag-badge tag-${tagId}">${escapeHtml(tagById.get(tagId).label)}</span>`
    )).join("");
  }

  function statCells(row) {
    const entry = row.entry;
    if (row.blankStats) {
      const blank = '<td class="stat-value stat-blank"><span class="sr-only">原種と同じ</span></td>';
      return blank.repeat(STAT_KEYS.length + 1);
    }
    if (entry.statsState !== "ok" || !entry.stats) {
      const label = entry.statsState === "pending" ? "確認中" : (entry.statsState === "fixed" ? "対象外" : "不明");
      return `<td class="stat-unknown" colspan="${STAT_KEYS.length + 1}">${label}</td>`;
    }
    const total = STAT_KEYS.reduce((sum, key) => sum + entry.stats[key], 0);
    // 固定の実数値から換算した値は、通常の種族値と見分けられるようにする。
    const mark = entry.converted ? ' stat-converted" title="固定の実数値から換算した種族値相当（詳細を参照）' : "";
    return STAT_KEYS.map((key) => `<td class="stat-value${mark}">${entry.stats[key]}</td>`).join("")
      + `<td class="stat-value stat-total${mark}">${total}</td>`;
  }

  function rowHtml(row) {
    const entry = row.entry;
    const classes = [row.role === "parent" ? "parent-row" : "child-row"];
    if (row.expandable) classes.push("expandable");
    if (row.expanded) classes.push("expanded");
    if (row.heading) classes.push("heading-row");
    let toggle = '<span class="toggle-spacer"></span>';
    let note = "";
    if (row.role === "parent" && row.expandable) {
      const label = `${entry.species}の姿違い${row.childCount}件を${row.expanded ? "閉じる" : "開く"}`;
      toggle = `<button type="button" class="toggle-button" data-toggle="${entry.no}" aria-expanded="${row.expanded}" `
        + `aria-label="${escapeHtml(label)}"${row.forced ? " disabled" : ""}>${row.expanded ? "▾" : "▸"}</button>`;
    }
    if (row.role === "child") toggle = "";
    if (row.role === "parent") {
      const notes = [];
      if (row.heading) notes.push("親・条件外／数値は参照用");
      if (row.forced && row.expanded) notes.push(state.allForms && !core.isFiltering(state.cond) ? "全姿表示中" : "検索結果を展開中");
      if (notes.length) note = `<span class="row-note">${notes.join("・")}</span>`;
    }
    if (row.orphan) classes.push("orphan-row");
    const count = row.role === "parent" && row.expandable
      ? `<span class="child-count" title="姿違い${row.childCount}件">＋${row.childCount}${row.reviewCount ? `（要確認${row.reviewCount}）` : ""}</span>`
      : "";
    const title = row.role === "parent" ? entry.species : entry.name;
    // 子行は表示名に姿名が入っているので、重ねて出さない。
    const form = entry.form && (row.role === "parent" || !entry.name.includes(entry.form))
      ? `<span class="form-label">${escapeHtml(entry.form)}</span>` : "";
    return `<tr class="${classes.join(" ")}" data-no="${entry.no}" data-id="${escapeHtml(entry.id)}">`
      + `<td class="dex-no">${String(entry.no).padStart(4, "0")}</td>`
      + `<td class="name-cell"><div class="name-line">${toggle}${imageTag(entry, 40)}`
      + `<span class="name-text">${escapeHtml(title)}${count}${form}${note}</span></div></td>`
      + `<td class="tags-cell">${tagBadges(entry)}</td>`
      + `<td class="types-cell">${typeBadges(entry.types)}</td>`
      + statCells(row)
      + `<td><button type="button" class="detail-button" data-detail="${escapeHtml(entry.id)}" `
      + `aria-label="${escapeHtml(entry.name)}の詳細">詳細</button></td></tr>`;
  }

  const tableWrap = $("table-wrap");
  const rowsBody = $("dex-rows");
  let rowHeight = 58;

  function readRowHeight() {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h"));
    if (value > 0) rowHeight = value;
  }

  /**
   * 見えている範囲の行だけを描画する。行の高さは CSS の --row-h で固定しているので、
   * 範囲外は上下の空行（高さだけ持つ行）で埋めて、スクロール位置と全体の高さを保つ。
   */
  function renderWindow(force) {
    const total = state.rows.length;
    const first = Math.floor(tableWrap.scrollTop / rowHeight);
    const visible = Math.ceil(tableWrap.clientHeight / rowHeight) + 1;
    const start = Math.max(0, first - OVERSCAN_ROWS);
    const end = Math.min(total, first + visible + OVERSCAN_ROWS);
    // 描画済みの範囲に十分な余裕があれば、何もしない。
    const covered = first - 2 >= state.windowStart || state.windowStart === 0;
    const coveredEnd = first + visible + 2 <= state.windowEnd || state.windowEnd === total;
    if (!force && covered && coveredEnd && first >= state.windowStart) return;
    state.windowStart = start;
    state.windowEnd = end;
    const spacer = (count) => (count > 0
      ? `<tr class="spacer-row" aria-hidden="true"><td colspan="${COLUMN_COUNT}" style="height:${count * rowHeight}px"></td></tr>`
      : "");
    rowsBody.innerHTML = spacer(start) + state.rows.slice(start, end).map(rowHtml).join("") + spacer(total - end);
  }

  let scrollQueued = false;
  tableWrap.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      renderWindow(false);
    });
  }, { passive: true });
  window.addEventListener("resize", () => {
    readRowHeight();
    renderWindow(true);
  });

  /** 行の一覧を作り直して表だけを描き直す（開閉のように、件数やフィルターが変わらない操作でも使う）。 */
  function renderTable(matched, filtering) {
    let rows = core.buildRows(entries, matched, {
      filtering: filtering,
      allForms: state.allForms,
      open: state.open,
    });
    if (!state.showParents) {
      // 条件に合わない親は出さない。親の数値を参照できないので、その子の種族値は空白にしない。
      rows = rows.filter((row) => !row.heading);
      const shownParents = new Set(rows.filter((row) => row.role === "parent").map((row) => row.entry.no));
      rows = rows.map((row) => (row.role === "child" && !shownParents.has(row.entry.no)
        ? Object.assign({}, row, { blankStats: false, orphan: true }) : row));
    }
    state.rows = rows;
    const heightBefore = tableWrap.clientHeight;
    renderWindow(true);
    // 行数が変わると表の枠の高さも変わるので、見える行数が増えたときは描き直す。
    if (tableWrap.clientHeight !== heightBefore) renderWindow(true);
    return rows;
  }

  function render() {
    const filtering = core.isFiltering(state.cond);
    const matched = core.filterEntries(entries, state.cond);
    state.matched = matched;
    renderConditions();
    renderFilters();
    tableWrap.scrollTop = 0;
    const rows = renderTable(matched, filtering);
    renderSummary(matched, rows, filtering);
    $("empty").hidden = matched.length > 0;
    // 条件に合わない親が出るのは絞り込み中だけなので、それ以外では切り替えを無効にする（値は保持する）。
    const showParents = $("show-parents");
    showParents.disabled = !filtering;
    showParents.parentElement.classList.toggle("disabled", !filtering);
    // 絞り込み中は一致した子を常に展開するため、全姿表示は切り替えられない（値は保持する）。
    const allForms = $("all-forms");
    allForms.disabled = filtering;
    allForms.parentElement.classList.toggle("disabled", filtering);
  }

  $("dex-rows").addEventListener("click", (event) => {
    const detail = event.target.closest("[data-detail]");
    if (detail) {
      openDetail(detail.dataset.detail, detail);
      return;
    }
    const row = event.target.closest("tr.parent-row.expandable");
    if (!row) return;
    const toggle = row.querySelector(".toggle-button");
    if (!toggle || toggle.disabled) return;
    const number = Number(row.dataset.no);
    if (state.open.has(number)) state.open.delete(number);
    else state.open.add(number);
    // 開閉では件数もフィルターも変わらないので、表だけを描き直す（スクロール位置は保つ）。
    const rows = renderTable(state.matched, core.isFiltering(state.cond));
    $("summary-sub").textContent = $("summary-sub").textContent.replace(/表示[0-9]+行/, `表示${rows.length}行`);
    const next = document.querySelector(`.toggle-button[data-toggle="${number}"]`);
    if (next && event.target.closest(".toggle-button")) next.focus();
  });

  // ---------- 詳細 ----------

  function openDetail(entryId, opener) {
    const entry = entryById.get(entryId);
    if (!entry) return;
    state.detailId = entryId;
    state.lastFocus = opener || null;
    const parent = entry.parent ? entryById.get(entry.parent) : null;
    const stats = entry.stats && entry.statsState === "ok"
      ? '<table class="detail-stats"><thead><tr>'
        + STAT_KEYS.map((key) => `<th>${key}</th>`).join("") + "<th>合計</th></tr></thead><tbody><tr>"
        + STAT_KEYS.map((key) => `<td>${entry.stats[key]}</td>`).join("")
        + `<td>${STAT_KEYS.reduce((sum, key) => sum + entry.stats[key], 0)}</td></tr></tbody></table>`
      : "<p>種族値: 不明</p>";
    const same = parent && core.sameStats(entry.stats, parent.stats) ? "（原種と同じ種族値）" : "";
    const tagText = entry.tags.filter((tagId) => tagById.has(tagId))
      .map((tagId) => tagById.get(tagId).label).join("、");
    $("detail-body").innerHTML =
      `${imageTag(entry, 144)}<h2 id="detail-title">${escapeHtml(entry.name)}</h2>`
      + `<div>${typeBadges(entry.types)}</div>${stats}`
      + "<dl>"
      + `<dt>全国番号</dt><dd>No.${String(entry.no).padStart(4, "0")} ${escapeHtml(entry.species)}（${escapeHtml(entry.en)}）</dd>`
      + `<dt>姿</dt><dd>${escapeHtml(entry.form || "（姿名なし）")}${entry.rep ? "／原種" : ""}${same}</dd>`
      + (parent ? `<dt>原種</dt><dd>${escapeHtml(parent.name)}</dd>` : "")
      + (entry.fixed ? `<dt>固定の実数値</dt><dd>Lv.${entry.fixed.level}: `
        + STAT_KEYS.map((key) => `${key}${entry.fixed.stats[key]}`).join(" ") + "（上の表は種族値への換算）</dd>" : "")
      + `<dt>特性</dt><dd>${escapeHtml(entry.abilities.join("、") || "未取得")}</dd>`
      + `<dt>タグ</dt><dd>${escapeHtml(tagText)}</dd>`
      + (entry.status === "needs_review" ? "<dt>状態</dt><dd>要確認</dd>" : "")
      + (entry.imgState !== "confirmed" ? `<dt>画像</dt><dd>${IMAGE_STATE_LABEL[entry.imgState] || entry.imgState}</dd>` : "")
      + `<dt>取得元</dt><dd>${escapeHtml(entry.sources.join("、"))}</dd>`
      + `<dt>ID</dt><dd><code>${escapeHtml(entry.id)}</code></dd>`
      + (entry.notes.length ? `<dt>メモ</dt><dd>${escapeHtml(entry.notes.join("／"))}</dd>` : "")
      + "</dl>";
    $("detail-panel").hidden = false;
    $("detail-close").focus();
  }

  function closeDetail() {
    if (state.detailId === null) return;
    state.detailId = null;
    $("detail-panel").hidden = true;
    if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
  }

  $("detail-close").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDetail();
  });

  const counts = data.meta.counts;
  $("footer-meta").textContent =
    `データ生成: ${data.meta.generatedAt} ／ 登録されている姿 ${counts.forms}件`
    + (hasReview ? `（採用${counts.included}・要確認${counts.needsReview}）` : "")
    + `・除外${counts.excluded}件・別枠の候補${counts.special}件`;
  // 動作確認用。画面には全行を描画しないため、全行の並びはここから参照する。
  window.DexApp = { rowIds: () => state.rows.map((row) => row.entry.id), rowHeight: () => rowHeight };
  readRowHeight();
  // 表示の切り替え（カード⇔一覧）で検索条件を引き継ぐための窓口。view-switch.js が使う。
  window.DexApp = Object.assign(window.DexApp || {}, {
    exportCondition: () => ({ cond: state.cond, condLabel: state.condLabel, allForms: state.allForms }),
    importCondition: (saved) => {
      state.cond = Object.assign(core.createCondition(), saved.cond);
      state.condLabel = saved.condLabel || "";
      state.allForms = Boolean(saved.allForms);
      const radio = document.querySelector('input[name="type-mode"][value="' + state.cond.typeMode + '"]');
      if (radio) radio.checked = true;
      $("show-review").checked = state.cond.showNeedsReview;
      $("all-forms").checked = state.allForms;
      render();
    },
  });
  render();
})();
