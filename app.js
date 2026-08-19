(() => {
  "use strict";

  const data = window.COMPLIANCE_DATA;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const priority = { red: 3, orange: 2, yellow: 1 };
  const riskLabels = { red: "红线禁用", orange: "高风险需审", yellow: "场景限用" };
  const sourceById = new Map(data.sources.map((item) => [item.id, item]));
  const termById = new Map(data.terms.map((item) => [item.id, item]));
  const traditionalMap = { "穩":"稳", "賺":"赚", "賠":"赔", "證":"证", "險":"险", "隨":"随", "價":"价", "貸":"贷", "錢":"钱", "絕":"绝", "對":"对", "業":"业", "績":"绩", "領":"领", "導":"导", "獨":"独", "權":"权", "銷":"销", "號":"号" };
  const ignoredChar = /[\s\p{P}\p{S}_]+/u;
  let findings = [];
  let toastTimer;
  let dbPromise;

  function normalizeUnit(char) {
    return char.normalize("NFKC").toLowerCase().split("").map((c) => traditionalMap[c] || c).join("");
  }

  function normalizeWithMap(text) {
    let value = "";
    const map = [];
    for (let i = 0; i < text.length; i += 1) {
      const unit = normalizeUnit(text[i]);
      for (const char of unit) {
        if (char !== "%" && ignoredChar.test(char)) continue;
        value += char;
        map.push(i);
      }
    }
    return { value, map };
  }

  const preparedTerms = data.terms.map((item) => ({ ...item, normalized: normalizeWithMap(item.term).value }));
  const preparedAliases = data.aliases.map((item) => ({ ...item, normalized: normalizeWithMap(item.alias).value }));

  function collectMatches(text) {
    if (!text.trim()) return [];
    const normalized = normalizeWithMap(text);
    const matches = [];
    const isNegatedOrEducational = (start) => {
      const clauseStart = Math.max(
        text.lastIndexOf("。", start - 1), text.lastIndexOf("！", start - 1),
        text.lastIndexOf("？", start - 1), text.lastIndexOf("；", start - 1),
        text.lastIndexOf("\n", start - 1), start - 28,
      ) + 1;
      const prefix = text.slice(clauseStart, start).replace(/[\s，,：:、“”‘’（）()]/g, "");
      return /(并非|并不|不是|不等于|绝非|不能|无法|不可能|不代表|不要|不应|不去|切勿|勿信|莫信|不可轻信|避免|谨防|警惕|拒绝|远离|严禁|禁止|杜绝)/.test(prefix);
    };
    const isFactualExemption = (start, end, item) => {
      const suffix = text.slice(end, end + 8).replace(/[\s，,：:、“”‘’（）()]/g, "");
      if (item.term === "最新" && /^(持仓|数据|公告|报告|净值|版本|日期|披露|一期|季度|年度)/.test(suffix)) return true;
      if (item.term === "第一" && /^(章|节|条|款|季度|部分|阶段|类|期)/.test(suffix)) return true;
      return false;
    };
    const scan = (needle, item, alias) => {
      if (!needle) return;
      let at = normalized.value.indexOf(needle);
      while (at !== -1) {
        const start = normalized.map[at];
        const end = normalized.map[at + needle.length - 1] + 1;
        if (!isNegatedOrEducational(start) && !isFactualExemption(start, end, item)) matches.push({ start, end, item, alias });
        at = normalized.value.indexOf(needle, at + 1);
      }
    };
    preparedTerms.forEach((item) => scan(item.normalized, item, null));
    preparedAliases.forEach((alias) => {
      const target = preparedTerms.find((item) => item.term === alias.target);
      if (target) scan(alias.normalized, target, alias.alias);
    });

    matches.sort((a, b) => a.start - b.start || priority[b.item.risk] - priority[a.item.risk] || (b.end - b.start) - (a.end - a.start));
    const selected = [];
    for (const candidate of matches) {
      const overlaps = selected.some((current) => candidate.start < current.end && candidate.end > current.start);
      if (!overlaps) selected.push(candidate);
    }
    return selected.sort((a, b) => a.start - b.start);
  }

  function escapeHtml(value) {
    return value.replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
  }

  function getStructuralWarnings(text) {
    const warnings = [];
    const hasInvestment = /(基金|私募|证券|股票|投资|理财|资产管理|投顾)/.test(text);
    const hasRiskNotice = /(投资有风险|基金有风险|过往业绩不代表未来|不构成投资建议|请谨慎投资)/.test(text);
    if (hasInvestment && !hasRiskNotice) warnings.push("文稿涉及投资、基金或资管内容，但未识别到常见风险提示；请结合产品和渠道要求补充醒目、完整的风险揭示。");
    const hasLoan = /(贷款|借款|借钱|分期|日息|月息|利率)/.test(text);
    const hasAnnualRate = /(年化利率|综合年化利率|年利率)/.test(text);
    if (hasLoan && !hasAnnualRate) warnings.push("文稿涉及贷款或分期，但未识别到年化利率表述；请核验是否需要明显展示综合年化利率及全部相关费用。");
    const hasInsurance = /(保险|保单|保费|投保|理赔)/.test(text);
    const hasInsuranceBoundary = /(责任免除|保险责任|以保险合同为准|具体以条款为准|保单利益具有不确定性)/.test(text);
    if (hasInsurance && !hasInsuranceBoundary) warnings.push("文稿涉及保险，但未识别到条款边界或责任提示；请核验保险责任、除外责任、费用和不确定利益披露是否完整。");
    return warnings;
  }

  function detect() {
    const text = $("#copyInput").value;
    findings = collectMatches(text);
    const counts = { red: 0, orange: 0, yellow: 0 };
    findings.forEach((finding) => { counts[finding.item.risk] += 1; });
    Object.keys(counts).forEach((risk) => { $(`#${risk}Count`).textContent = counts[risk]; });

    const overall = $("#overallRisk");
    if (!text.trim()) {
      overall.className = "risk-pill neutral";
      overall.textContent = "未检测";
    } else if (counts.red) {
      overall.className = "risk-pill red";
      overall.textContent = "红线禁用";
    } else if (counts.orange) {
      overall.className = "risk-pill orange";
      overall.textContent = "高风险需审";
    } else if (counts.yellow) {
      overall.className = "risk-pill yellow";
      overall.textContent = "场景限用";
    } else {
      overall.className = "risk-pill safe";
      overall.textContent = "未发现词库风险";
    }

    const output = $("#annotatedText");
    if (!text) {
      output.className = "annotated-text empty";
      output.textContent = "检测结果将在这里显示。";
    } else {
      output.className = "annotated-text";
      let cursor = 0;
      output.innerHTML = findings.map((finding, index) => {
        const before = escapeHtml(text.slice(cursor, finding.start));
        const matched = escapeHtml(text.slice(finding.start, finding.end));
        cursor = finding.end;
        return `${before}<mark class="finding ${finding.item.risk}" tabindex="0" data-index="${index}" title="${riskLabels[finding.item.risk]}：点击查看详情">${matched}</mark>`;
      }).join("") + escapeHtml(text.slice(cursor));
    }

    const structural = getStructuralWarnings(text);
    const warningBox = $("#structuralWarnings");
    warningBox.hidden = structural.length === 0;
    warningBox.innerHTML = structural.length ? `<h4>结构性提醒</h4><ul>${structural.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
    $("#resultHint").textContent = text ? `已完成本地检测，发现 ${findings.length} 处词库命中。` : "输入文稿后自动检测；点击高亮词查看详情。";
  }

  function updateCharCount() {
    const count = $("#copyInput").value.length;
    const counter = $("#charCount");
    counter.textContent = `${count} / 5000`;
    counter.classList.toggle("over", count > 5000);
    $("#lengthWarning").hidden = count <= 5000;
  }

  function showDetail(index) {
    const finding = findings[index];
    if (!finding) return;
    const item = finding.item;
    $("#detailPanel").hidden = false;
    $("#detailRisk").className = `risk-pill ${item.risk}`;
    $("#detailRisk").textContent = riskLabels[item.risk];
    $("#detailTerm").textContent = finding.alias ? `${item.term}（由“${finding.alias}”识别）` : item.term;
    $("#detailScene").textContent = item.scene || "全部金融营销";
    $("#detailRule").textContent = item.rule;
    $("#detailAction").textContent = item.action;
    const linkedSources = item.sourceIds.map((id) => sourceById.get(id)).filter(Boolean);
    $("#detailSources").innerHTML = linkedSources.length ? linkedSources.map((source) => `<a href="${source.url}" target="_blank" rel="noopener noreferrer">${source.id} · ${escapeHtml(source.name)}</a>`).join("<br>") : "请由合规人员结合现行规定复核。";
    $("#detailPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("hui-compliance-local", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function historyTransaction(mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("history", mode);
      const store = tx.objectStore("history");
      const result = callback(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveHistory() {
    const text = $("#copyInput").value.trim();
    if (!text) return showToast("请先输入文稿");
    const counts = { red: 0, orange: 0, yellow: 0 };
    findings.forEach((finding) => { counts[finding.item.risk] += 1; });
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString(), title: text.split(/\n/)[0].slice(0, 36) || "未命名文稿", text, counts };
    await historyTransaction("readwrite", (store) => store.put(entry));
    showToast("已仅保存到当前电脑浏览器");
    renderHistory();
  }

  async function getHistory() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction("history", "readonly").objectStore("history").getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteHistory(id) {
    await historyTransaction("readwrite", (store) => store.delete(id));
    renderHistory();
  }

  async function clearHistory() {
    if (!confirm("确定清空当前浏览器中的全部历史记录吗？此操作无法恢复。")) return;
    await historyTransaction("readwrite", (store) => store.clear());
    renderHistory();
    showToast("本机历史记录已清空");
  }

  async function renderHistory() {
    const list = $("#historyList");
    try {
      const entries = await getHistory();
      if (!entries.length) {
        list.innerHTML = '<div class="empty-state">当前电脑的浏览器中还没有历史记录。</div>';
        return;
      }
      list.innerHTML = entries.map((entry) => `<article class="history-item" data-id="${entry.id}">
        <div class="history-top"><div><h3>${escapeHtml(entry.title)}</h3><div class="history-meta">${new Date(entry.createdAt).toLocaleString("zh-CN")} · ${entry.text.length} 字 · 红 ${entry.counts.red} / 橙 ${entry.counts.orange} / 黄 ${entry.counts.yellow}</div></div></div>
        <div class="history-preview">${escapeHtml(entry.text.slice(0, 180))}${entry.text.length > 180 ? "…" : ""}</div>
        <div class="history-actions"><button class="button button-secondary load-history">载入检测</button><button class="button button-danger delete-history">删除</button></div>
      </article>`).join("");
      $$(".history-item", list).forEach((node) => {
        const entry = entries.find((item) => item.id === node.dataset.id);
        $(".load-history", node).addEventListener("click", () => {
          $("#copyInput").value = entry.text;
          updateCharCount(); detect(); switchView("detect");
        });
        $(".delete-history", node).addEventListener("click", () => deleteHistory(entry.id));
      });
    } catch {
      list.innerHTML = '<div class="empty-state">浏览器阻止了本地历史记录功能，请检查隐私或无痕模式设置。</div>';
    }
  }

  function renderRules() {
    $("#rulesGrid").innerHTML = data.variantRules.map((rule) => `<article class="rule-card"><span class="rule-id">${rule.id}</span><h3>${escapeHtml(rule.type)}</h3><p class="rule-example">示例：${escapeHtml(rule.example)}</p><p><strong>标准化：</strong>${escapeHtml(rule.normalization)}</p><p><strong>控制要点：</strong>${escapeHtml(rule.control)}</p></article>`).join("");
  }

  function renderLaws() {
    $("#lawsList").innerHTML = data.sources.map((source) => `<article class="law-card"><div><span class="law-status">${escapeHtml(source.status)}</span></div><div><h3>${source.id} · ${escapeHtml(source.name)}</h3><p>${escapeHtml(source.summary)}</p></div><a class="law-link" href="${source.url}" target="_blank" rel="noopener noreferrer">打开官方链接 ↗</a></article>`).join("");
  }

  function switchView(id) {
    $$(".view").forEach((view) => view.classList.toggle("is-active", view.id === id));
    $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === id));
    if (id === "history") renderHistory();
    history.replaceState(null, "", `#${id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  let debounce;
  $("#copyInput").addEventListener("input", () => {
    updateCharCount();
    clearTimeout(debounce);
    debounce = setTimeout(detect, 180);
  });
  $("#annotatedText").addEventListener("click", (event) => {
    const mark = event.target.closest("mark[data-index]");
    if (mark) showDetail(Number(mark.dataset.index));
  });
  $("#annotatedText").addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("mark[data-index]")) showDetail(Number(event.target.dataset.index));
  });
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  $("#closeDetail").addEventListener("click", () => { $("#detailPanel").hidden = true; });
  $("#clearBtn").addEventListener("click", () => { $("#copyInput").value = ""; updateCharCount(); detect(); $("#detailPanel").hidden = true; });
  $("#copyBtn").addEventListener("click", async () => {
    const text = $("#copyInput").value;
    if (!text) return showToast("当前没有可复制的文稿");
    await navigator.clipboard.writeText(text); showToast("当前文稿已复制");
  });
  $("#saveBtn").addEventListener("click", saveHistory);
  $("#clearHistoryBtn").addEventListener("click", clearHistory);
  $("#sampleBtn").addEventListener("click", () => {
    $("#copyInput").value = "这是一只稳赚不赔、保证收益的明星基金，内部消息显示买入即涨。产品低风险、低门槛，申购良机不容错过！保险产品什么都保，贷款可实现秒到账。";
    updateCharCount(); detect();
  });

  renderRules(); renderLaws(); updateCharCount(); detect();
  const initialView = location.hash.slice(1);
  if (["detect", "rules", "laws", "history"].includes(initialView)) switchView(initialView);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
})();

