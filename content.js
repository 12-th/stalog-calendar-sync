const PERIOD_TIMES = {
  1: ["09:00", "09:50"],
  2: ["10:00", "10:50"],
  3: ["11:00", "11:50"],
  4: ["12:40", "13:30"],
  5: ["13:40", "14:30"],
  6: ["14:40", "15:30"],
};

const BUTTON_ID = "stalog-google-calendar-sync";
const SETTINGS_ID = "stalog-completeness-settings";
const CHECK_BUTTON_CLASS = "stalog-completeness-check";
const CHECK_PANEL_CLASS = "stalog-completeness-panel";
const CHECK_BUBBLE_ID = "stalog-completeness-bubble";
const CHECK_MIN_INTERVAL = 3000;
const AUTO_CHECK_INTERVAL = 60 * 60 * 1000;
const COMPLETENESS_STORAGE_KEY = "completenessResults";
const COMPLETENESS_RESULT_VERSION = 2;
const HIDDEN_ITEMS_STORAGE_KEY = "hiddenCompletenessItems";
const NEXT_WEEK_SELECTOR = ".after-seven-day-btn";
const WEEK_CHANGE_TIMEOUT = 15000;
const WEEK_CHANGE_INTERVAL = 250;
let completenessButtonObserver = null;
let completenessButtonUpdateQueued = false;
let completenessBubbleOutsideClickHandler = null;
let completenessBubblePositionHandler = null;
let activeCompletenessButton = null;
let lastCompletenessRequestAt = 0;
let completenessAutoCheckTimer = null;
let showNonPerfectScores = false;
let completenessReportDocument = null;
let completenessReportPromise = null;
let hiddenCompletenessItems = new Set();
let showHiddenCompletenessItems = false;
const completenessResults = new Map();
let directorySelectionObserver = null;
let directorySelectionCompleted = false;
let isAutoSelectingDirectory = false;
let directorySelectionClickHandler = null;

function parseMonthDays(text) {
  return Array.from(text.matchAll(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/g)).map(
    (match) => `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}`,
  );
}

function getTodayMonthDay() {
  const today = new Date();
  return `${String(today.getMonth() + 1).padStart(2, "0")}/${String(
    today.getDate(),
  ).padStart(2, "0")}`;
}

function findCurrentLessonNumber() {
  const today = getTodayMonthDay();
  const timetable = Array.from(document.querySelectorAll("table")).find(
    (table) =>
      table.textContent.includes("実施日") &&
      table.textContent.includes("授業動画"),
  );
  if (!timetable) {
    return 0;
  }

  const lessonDates = Array.from(timetable.querySelectorAll("tbody tr"))
    .map((row) => parseMonthDays(row.cells[0]?.textContent || "")[0])
    .filter(Boolean);
  const uniqueDates = lessonDates.filter(
    (date, index, dates) => dates.indexOf(date) === index,
  );
  const todayIndex = uniqueDates.indexOf(today);
  if (todayIndex >= 0) {
    return todayIndex + 1;
  }

  const todayValue = Number(today.replace("/", ""));
  const nextIndex = uniqueDates.findIndex(
    (date) => Number(date.replace("/", "")) >= todayValue,
  );
  return nextIndex >= 0 ? nextIndex + 1 : 0;
}

function selectTodayClassDirectory() {
  if (document.title.includes("ロジカル")) {
    return true;
  }

  if (
    !document.querySelector(
      "#div-class-directories, .div-panel-directory, .class-directory",
    )
  ) {
    return false;
  }

  const lessonNumber = findCurrentLessonNumber();
  if (!lessonNumber) {
    return false;
  }

  const directoryItems = Array.from(
    document.querySelectorAll("li.x-directory-drag[directory_id]"),
  );
  const directoryItem = directoryItems[lessonNumber - 1];
  if (!directoryItem) {
    return false;
  }

  const directory = directoryItem.querySelector(
    ".a-open-contents[directory_id]",
  );
  if (!directory) {
    return false;
  }

  if (directory.dataset.stalogAutoSelected === "true") {
    return true;
  }

  directory.dataset.stalogAutoSelected = "true";
  isAutoSelectingDirectory = true;
  directory.click();
  directoryItem.scrollIntoView({ behavior: "smooth", block: "center" });
  isAutoSelectingDirectory = false;
  return true;
}

function startTodayClassDirectorySelection() {
  if (directorySelectionObserver || directorySelectionCompleted) {
    return;
  }

  const stopSelection = () => {
    directorySelectionObserver?.disconnect();
    directorySelectionObserver = null;
    if (directorySelectionClickHandler) {
      document.removeEventListener(
        "click",
        directorySelectionClickHandler,
        true,
      );
      directorySelectionClickHandler = null;
    }
  };

  directorySelectionClickHandler = (event) => {
    if (
      !isAutoSelectingDirectory &&
      event.target instanceof Element &&
      event.target.closest("li.x-directory-drag[directory_id]")
    ) {
      directorySelectionCompleted = true;
      stopSelection();
    }
  };
  document.addEventListener("click", directorySelectionClickHandler, true);

  const trySelectDirectory = () => {
    if (selectTodayClassDirectory()) {
      directorySelectionCompleted = true;
      stopSelection();
    }
  };

  directorySelectionObserver = new MutationObserver(trySelectDirectory);
  directorySelectionObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  trySelectDirectory();
}

function saveCompletenessResults() {
  const results = Object.fromEntries(completenessResults);
  chrome.storage.local
    .set({ [COMPLETENESS_STORAGE_KEY]: results })
    .catch((error) => {
      console.warn("未提出確認の結果を保存できませんでした", error);
    });
}

function getItemKey(classId, item) {
  return `${classId}|${item.href}|${item.name}`;
}

function saveHiddenCompletenessItems() {
  chrome.storage.local
    .set({ [HIDDEN_ITEMS_STORAGE_KEY]: [...hiddenCompletenessItems] })
    .catch((error) => {
      console.warn("非表示項目を保存できませんでした", error);
    });
}

function isHiddenCompletenessItem(classId, item) {
  return hiddenCompletenessItems.has(getItemKey(classId, item));
}

function getVisibleCompletenessInformation(classId, information) {
  if (!information) {
    return information;
  }
  if (showHiddenCompletenessItems) {
    return information;
  }
  return {
    assignment: information.assignment.filter(
      (item) => !isHiddenCompletenessItem(classId, item),
    ),
    digest: information.digest.filter(
      (item) => !isHiddenCompletenessItem(classId, item),
    ),
  };
}

async function loadCompletenessResults() {
  try {
    const stored = await chrome.storage.local.get({
      [COMPLETENESS_STORAGE_KEY]: {},
    });
    Object.entries(stored[COMPLETENESS_STORAGE_KEY] || {}).forEach(
      ([classId, result]) => {
        if (
          result &&
          typeof result === "object" &&
          result.version === COMPLETENESS_RESULT_VERSION
        ) {
          completenessResults.set(classId, result);
        }
      },
    );
    addCompletenessButtons();
  } catch (error) {
    console.warn("未提出確認の結果を読み込めませんでした", error);
  }
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function getClassIdFromScheduleLink(url) {
  const match = url.match(/\/lms\/class\/(\d+)(?:\/\d+)?(?:\/|$)/);
  return match ? match[1] : null;
}

function extractMyPageClassInformation(
  documentRoot,
  classId,
  includeNonPerfect = showNonPerfectScores,
) {
  const section = documentRoot.querySelector(
    `.class-row[classid="${classId}"]`,
  );
  if (!section) {
    return null;
  }
  const items = Array.from(section.querySelectorAll("tbody tr.item-row"))
    .map((row) => {
      const cells = row.querySelectorAll("td");
      const name = cells[1]?.textContent?.replace(/\s+/g, " ").trim();
      const status = cells[3]?.textContent?.replace(/\s+/g, " ").trim() || "";
      if (!name) {
        return null;
      }
      const itemLink = row.querySelector("a[href]");
      const href = itemLink?.getAttribute("href") || "";
      const score = status.match(/完了\s*\((\d+)\/(\d+)点\)/);
      const isDigest = name.includes("ダイジェスト");
      return {
        name,
        isDigest,
        isAssignment: !isDigest,
        completed: !/未完了|未提出/.test(status) && /完了|提出済/.test(status),
        accuracy: "",
        highestScore: score ? `${score[1]}/${score[2]}点` : "",
        nonPerfect: Boolean(score && score[1] !== score[2]),
        status,
        href,
      };
    })
    .filter(Boolean);
  return {
    assignment: items.filter(
      (item) =>
        item.isAssignment &&
        (!item.completed || (includeNonPerfect && item.nonPerfect)),
    ),
    digest: items.filter(
      (item) =>
        item.isDigest &&
        (!item.completed || (includeNonPerfect && item.nonPerfect)),
    ),
  };
}

function positionCompletenessBubble(button, panel) {
  const buttonRect = button.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, buttonRect.left),
    window.innerWidth - panel.offsetWidth - 8,
  );
  const top =
    buttonRect.bottom + panel.offsetHeight + 12 < window.innerHeight
      ? buttonRect.bottom + 8
      : Math.max(8, buttonRect.top - panel.offsetHeight - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function closeCompletenessBubble() {
  document.getElementById(CHECK_BUBBLE_ID)?.remove();
  activeCompletenessButton = null;
  if (completenessBubbleOutsideClickHandler) {
    document.removeEventListener(
      "click",
      completenessBubbleOutsideClickHandler,
      true,
    );
    completenessBubbleOutsideClickHandler = null;
  }
  if (completenessBubblePositionHandler) {
    window.removeEventListener(
      "scroll",
      completenessBubblePositionHandler,
      true,
    );
    window.removeEventListener("resize", completenessBubblePositionHandler);
    completenessBubblePositionHandler = null;
  }
}

function setCompletenessButtonState(
  button,
  text,
  { incompleteCount = 0, nonPerfectCount = 0 } = {},
) {
  button.textContent = text;
  const addBadge = (count, background, label) => {
    if (count <= 0) {
      return;
    }
    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.title = label;
    badge.style.cssText = `display:inline-block;min-width:16px;margin-left:4px;padding:0 4px;border-radius:10px;background:${background};color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;vertical-align:middle;`;
    button.append(badge);
  };
  addBadge(incompleteCount, "#d93025", "未提出・未完了");
  addBadge(nonPerfectCount, "#d69e2e", "満点以外");
}

function getButtonClassId(button) {
  const href = button
    .closest(".top-timetable-table-td")
    ?.querySelector(".div-class-name section a")?.href;
  return href ? getClassIdFromScheduleLink(href) : null;
}

function applyCompletenessResultToButton(button, result) {
  const classId = getButtonClassId(button);
  const information = getVisibleCompletenessInformation(
    classId,
    result?.information,
  );
  const items = information
    ? [...information.assignment, ...information.digest]
    : [];
  button.dataset.incompleteCount = String(
    items.filter((item) => !item.completed).length,
  );
  button.dataset.nonPerfectCount = String(
    items.filter((item) => item.completed && item.nonPerfect).length,
  );
  setCompletenessButtonState(button, "未提出確認", {
    incompleteCount: Number(button.dataset.incompleteCount),
    nonPerfectCount: Number(button.dataset.nonPerfectCount),
  });
}

function applyCachedCompletenessResult(classId) {
  if (!classId) {
    return;
  }
  const result = completenessResults.get(classId);
  if (!result) {
    return;
  }
  document.querySelectorAll(`.${CHECK_BUTTON_CLASS}`).forEach((button) => {
    if (getButtonClassId(button) === classId) {
      applyCompletenessResultToButton(button, result);
    }
  });
}

async function refreshCompletenessBadges() {
  if (document.hidden) {
    return;
  }

  const buttons = Array.from(
    document.querySelectorAll(`.${CHECK_BUTTON_CLASS}`),
  );
  if (!buttons.length) {
    return;
  }

  completenessReportDocument = null;
  const documentRoot = await fetchCompletenessReport();
  buttons.forEach((button) => {
    const classId = getButtonClassId(button);
    if (!classId) {
      return;
    }
    const information = extractMyPageClassInformation(documentRoot, classId);
    if (!information) {
      return;
    }
    const result = {
      version: COMPLETENESS_RESULT_VERSION,
      information,
      debugMessages: [
        `自動更新: ${new Date().toLocaleString("ja-JP")}`,
        `対象クラス: ${classId} / 課題: ${information.assignment.length}件 / ダイジェスト: ${information.digest.length}件`,
      ],
    };
    completenessResults.set(classId, result);
    applyCachedCompletenessResult(classId);
  });
  saveCompletenessResults();
}

async function fetchCompletenessReport() {
  if (completenessReportPromise) {
    return completenessReportPromise;
  }
  completenessReportPromise = (async () => {
    const response = await fetch(
      `${location.origin}/portal/lmsinc/myReportStatus.php`,
      { credentials: "include" },
    );
    if (!response.ok) {
      throw new Error(`提出状況の取得に失敗しました (${response.status})`);
    }
    completenessReportDocument = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    return completenessReportDocument;
  })();
  try {
    return await completenessReportPromise;
  } finally {
    completenessReportPromise = null;
  }
}

function startCompletenessAutoCheck() {
  if (completenessAutoCheckTimer) {
    return;
  }
  completenessAutoCheckTimer = window.setInterval(() => {
    refreshCompletenessBadges().catch((error) => {
      console.warn("スタログ提出状況の自動更新に失敗しました", error);
    });
  }, AUTO_CHECK_INTERVAL);
}

function renderCompletenessPanel(
  button,
  className,
  classId,
  information,
  message,
  debugMessages = [],
) {
  closeCompletenessBubble();
  const panel = document.createElement("section");
  panel.id = CHECK_BUBBLE_ID;
  panel.className = CHECK_PANEL_CLASS;
  panel.style.cssText =
    "position:fixed;z-index:10000;width:220px;max-height:calc(100vh - 16px);overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;padding:10px 12px;border:1px solid #9cc9e8;border-radius:8px;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:12px;overflow-wrap:anywhere;";
  document.body.append(panel);
  activeCompletenessButton = button;
  panel.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  panel.addEventListener(
    "wheel",
    (event) => {
      event.stopPropagation();
    },
    { passive: true },
  );
  completenessBubbleOutsideClickHandler = (event) => {
    if (event.target === activeCompletenessButton) {
      return;
    }
    if (event.target instanceof Node && panel.contains(event.target)) {
      return;
    }
    closeCompletenessBubble();
  };
  document.addEventListener(
    "click",
    completenessBubbleOutsideClickHandler,
    true,
  );
  const formatItems = (items) =>
    items.length
      ? items
          .map((item) => {
            const statusColor = !item.completed
              ? "#c0392b"
              : item.nonPerfect
                ? "#b7791f"
                : "#25803a";
            const itemKey = getItemKey(classId, item);
            return `<div style="margin-top:4px;">・${
              item.href
                ? `<a href="${escapeHtml(
                    new URL(item.href, location.origin).href,
                  )}" style="color:inherit;text-decoration:underline;">${escapeHtml(item.name)}</a>`
                : escapeHtml(item.name)
            }：<b style="color:${statusColor};">${escapeHtml(item.status || (item.completed ? "提出済み" : "未提出"))}</b>${item.accuracy ? `／正解率 ${item.accuracy}%` : ""}<button type="button" data-hide-item="${escapeHtml(itemKey)}" style="margin-left:4px;padding:0 4px;border:1px solid #aaa;border-radius:3px;background:#fff;color:#666;font-size:10px;line-height:14px;cursor:pointer;" title="この項目を非表示">−</button></div>`;
          })
          .join("")
      : '<div style="margin-top:4px;color:#25803a;">未提出・未完了なし</div>';
  panel.innerHTML = information
    ? `<strong>${escapeHtml(className)}</strong><div style="margin-top:6px;"><b>課題</b>${formatItems(information.assignment)}<div style="margin-top:6px;"><b>ダイジェスト</b>${formatItems(information.digest)}</div></div>`
    : `<strong>${escapeHtml(className)}</strong><p style="margin:4px 0 0;">${escapeHtml(message)}</p>`;
  positionCompletenessBubble(button, panel);
  completenessBubblePositionHandler = () =>
    positionCompletenessBubble(button, panel);
  window.addEventListener("scroll", completenessBubblePositionHandler, true);
  window.addEventListener("resize", completenessBubblePositionHandler);
  panel.addEventListener("click", (event) => {
    const hideButton =
      event.target instanceof Element
        ? event.target.closest("[data-hide-item]")
        : null;
    if (!hideButton) {
      return;
    }
    if (hideButton.dataset.confirmed === "true") {
      hiddenCompletenessItems.add(hideButton.dataset.hideItem);
      saveHiddenCompletenessItems();
      closeCompletenessBubble();
      applyCachedCompletenessResult(classId);
      return;
    }
    hideButton.dataset.confirmed = "true";
    hideButton.textContent = "本当に消しますか？";
    hideButton.style.color = "#c0392b";
  });
}

async function checkClassAutomatically(button, className) {
  const debugMessages = [`対象授業: ${className}`];
  const classLink = button
    .closest(".top-timetable-table-td")
    ?.querySelector(".div-class-name section a");
  if (!classLink?.href) {
    throw new Error("時間割の授業リンクを取得できませんでした。");
  }
  const classId = getClassIdFromScheduleLink(classLink.href);
  if (!classId) {
    throw new Error("時間割リンクから授業IDを取得できませんでした。");
  }
  const elapsed = Date.now() - lastCompletenessRequestAt;
  if (!completenessReportDocument && elapsed < CHECK_MIN_INTERVAL) {
    await wait(CHECK_MIN_INTERVAL - elapsed);
  }
  let result;
  try {
    if (!completenessReportDocument) {
      lastCompletenessRequestAt = Date.now();
      debugMessages.push("ページ読み込み後の初回取得");
      await fetchCompletenessReport();
    } else {
      debugMessages.push("ページ内の取得済みデータを使用");
    }
    const documentRoot = completenessReportDocument;
    if (!documentRoot) {
      throw new Error("提出状況データを読み込めませんでした。");
    }
    const information = extractMyPageClassInformation(documentRoot, classId);
    debugMessages.push(
      `対象クラス: ${classId} / 課題: ${information?.assignment.length || 0}件 / ダイジェスト: ${information?.digest.length || 0}件`,
    );
    result = {
      version: COMPLETENESS_RESULT_VERSION,
      information,
      debugMessages,
    };
  } catch (error) {
    result = {
      information: null,
      debugMessages: [
        ...debugMessages,
        `取得失敗: ${error instanceof Error ? error.message : String(error)}`,
        "再通信は行いません。",
      ],
    };
  }
  completenessResults.set(classId, result);
  saveCompletenessResults();
  return result;
}

function removeRepeatedMarker(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node);
    node = walker.nextNode();
  }
  textNodes.forEach((textNode) => {
    if (textNode.nodeValue?.trim() === "〃") {
      container.dataset.stalogRepeatedClass = "true";
      textNode.remove();
    }
  });
}

function addCompletenessButtons() {
  if (!document.querySelector("#overrided-schedule")) {
    return;
  }
  const rows = Array.from(
    document.querySelectorAll("#overrided-schedule tbody tr"),
  );
  const previousClasses = [];

  rows.forEach((row) => {
    row
      .querySelectorAll("td.top-timetable-table-td")
      .forEach((cell, dayIndex) => {
        const classLink = cell.querySelector(".div-class-name section a");
        const className = classLink?.textContent?.replace(/\s+/g, " ").trim();
        const classContainer = cell.querySelector(".div-class-name");
        if (classContainer) {
          removeRepeatedMarker(classContainer);
        }
        if (className) {
          previousClasses[dayIndex] = className;
          if (
            classContainer &&
            !classContainer.querySelector(`.${CHECK_BUTTON_CLASS}`)
          ) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "未提出確認";
            button.className = `btn btn-info ${CHECK_BUTTON_CLASS}`;
            button.style.cssText =
              "display:block;position:relative;top:-2px;z-index:1000;margin:0 0 -2px;font-size:11px;line-height:15px;padding:2px 6px;white-space:nowrap;";
            button.addEventListener(
              "click",
              (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (
                  activeCompletenessButton === button &&
                  document.getElementById(CHECK_BUBBLE_ID)
                ) {
                  closeCompletenessBubble();
                  return;
                }
                button.disabled = true;
                setCompletenessButtonState(button, "確認中");
                checkClassAutomatically(button, className)
                  .then((result) => {
                    renderCompletenessPanel(
                      button,
                      className,
                      getButtonClassId(button),
                      getVisibleCompletenessInformation(
                        getButtonClassId(button),
                        result.information,
                      ),
                      "授業内容を自動確認できませんでした。",
                      result.debugMessages,
                    );
                    const classId = getButtonClassId(button);
                    applyCachedCompletenessResult(classId);
                  })
                  .catch((error) => {
                    renderCompletenessPanel(
                      button,
                      className,
                      getButtonClassId(button),
                      null,
                      "授業内容の自動確認に失敗しました。",
                      [
                        `処理中に例外が発生しました: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      ],
                    );
                  })
                  .finally(() => {
                    button.disabled = false;
                    applyCompletenessResultToButton(button, {
                      information: completenessResults.get(
                        getButtonClassId(button),
                      )?.information,
                    });
                  });
              },
              true,
            );
            button.addEventListener(
              "mousedown",
              (event) => {
                event.preventDefault();
                event.stopPropagation();
              },
              true,
            );
            classContainer.append(button);
            applyCachedCompletenessResult(getButtonClassId(button));
          }
          return;
        }

        const classCellText = classContainer?.textContent
          ?.replace(/\s+/g, " ")
          .trim();
        const repeatedClass = classCellText === "〃";
        if (!repeatedClass || !previousClasses[dayIndex]) {
          return;
        }
        classContainer.replaceChildren();
      });
  });
}

function startCompletenessButtonObserver() {
  if (completenessButtonObserver || !document.body) {
    return;
  }

  completenessButtonObserver = new MutationObserver(() => {
    if (completenessButtonUpdateQueued) {
      return;
    }
    completenessButtonUpdateQueued = true;
    requestAnimationFrame(() => {
      completenessButtonUpdateQueued = false;
      addCompletenessButtons();
    });
  });
  completenessButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  addCompletenessButtons();
}

function extractSchedule() {
  const dates = Array.from(
    document.querySelectorAll(".table-week-data-content td.week-data-content"),
  ).map((cell) => cell.getAttribute("date")?.trim());
  const rows = document.querySelectorAll("#overrided-schedule tbody tr");
  const events = [];
  const previousClasses = [];
  const occupiedUntil = [];
  const cells = [];

  Array.from(rows).forEach((row, rowIndex) => {
    let dayIndex = 0;
    row.querySelectorAll("td.top-timetable-table-td").forEach((cell) => {
      while ((occupiedUntil[dayIndex] || 0) > rowIndex) {
        dayIndex += 1;
      }

      const rowSpan = Number(cell.getAttribute("rowspan") || 1);
      const columnSpan = Number(cell.getAttribute("colspan") || 1);
      for (let column = 0; column < columnSpan; column += 1) {
        occupiedUntil[dayIndex + column] = rowIndex + rowSpan;
      }
      cells.push({ cell, dayIndex, rowIndex, rowSpan });
      dayIndex += columnSpan;
    });
  });

  cells.forEach(({ cell, dayIndex, rowIndex, rowSpan }) => {
    const date = dates[dayIndex];
    const classLink = cell.querySelector(".div-class-name section a");
    const startPeriod = Number(
      cell.querySelector(".div-unit-index")?.textContent.trim().match(/[1-6]/)?.[0] ||
        rowIndex + 1,
    );
    if (!date || !PERIOD_TIMES[startPeriod]) {
      return;
    }

    const classContainer = cell.querySelector(".div-class-name");
    const repeatedClass =
      classContainer?.dataset.stalogRepeatedClass === "true" ||
      classContainer?.textContent.includes("〃");
    const previousClass = previousClasses[dayIndex];
    const classData = classLink
      ? {
          summary: classLink.textContent.trim(),
          location: getClassroom(cell),
        }
      : repeatedClass
        ? previousClass
        : null;

    if (!classData?.summary) {
      return;
    }

    previousClasses[dayIndex] = classData;
    for (let offset = 0; offset < rowSpan; offset += 1) {
      const period = startPeriod + offset;
      const time = PERIOD_TIMES[period];
      if (!time) {
        break;
      }
      events.push({
        summary: classData.location
          ? `${classData.location} ${classData.summary}`
          : classData.summary,
        location: classData.location,
        start: toIsoString(date, time[0]),
        end: toIsoString(date, time[1]),
      });
    }
  });

  return events;
}

function getClassroom(cell) {
  const classroomLabel = Array.from(cell.querySelectorAll("small")).find(
    (element) => element.textContent.includes("教室"),
  );
  if (!classroomLabel?.parentElement) {
    return "";
  }

  return classroomLabel.parentElement.textContent
    .replace(classroomLabel.textContent, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoString(date, time) {
  return `${date}T${time}:00+09:00`;
}

function getWeekDates() {
  return Array.from(
    document.querySelectorAll(".table-week-data-content td.week-data-content"),
  ).map((cell) => cell.getAttribute("date")?.trim() || "");
}

function getWeekRange() {
  const dates = getWeekDates().filter(Boolean);
  return {
    weekStart: dates[0],
    weekEnd: dates[dates.length - 1],
  };
}

function getAcademicYearEndDate() {
  const today = new Date();
  const endYear =
    today.getMonth() >= 3 ? today.getFullYear() + 1 : today.getFullYear();
  return `${endYear}-04-30`;
}

function getScheduleSignature() {
  return document.querySelector("#overrided-schedule")?.innerHTML || "";
}

function isFinished() {
  const firstDate = getWeekDates().find(Boolean);
  return Boolean(firstDate && firstDate > getAcademicYearEndDate());
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWeekChange(previousDates, previousSchedule) {
  const deadline = Date.now() + WEEK_CHANGE_TIMEOUT;
  let datesChangedAt = 0;

  while (Date.now() < deadline) {
    const currentDates = getWeekDates();
    const datesChanged =
      currentDates.length > 0 &&
      currentDates.some((date, index) => date !== previousDates[index]);

    if (datesChanged && !datesChangedAt) {
      datesChangedAt = Date.now();
    }

    if (
      datesChanged &&
      (getScheduleSignature() !== previousSchedule ||
        Date.now() - datesChangedAt >= 1000)
    ) {
      await wait(500);
      return;
    }

    await wait(WEEK_CHANGE_INTERVAL);
  }
  throw new Error("次の週への移動を確認できませんでした。");
}

async function syncWeeks(button) {
  let totalCreated = 0;
  let weeks = 0;

  while (!isFinished()) {
    const events = extractSchedule();
    const { weekStart, weekEnd } = getWeekRange();
    if (!weekStart || !weekEnd) {
      throw new Error("同期対象週の日付を取得できませんでした。");
    }
    const response = await chrome.runtime.sendMessage({
      type: "SYNC_SCHEDULE",
      events,
      weekStart,
      weekEnd,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "同期に失敗しました。");
    }

    totalCreated += response.created;
    weeks += 1;

    if (isFinished()) {
      return { totalCreated, weeks };
    }

    const previousDates = getWeekDates();
    const previousSchedule = getScheduleSignature();
    const nextWeekButton = document.querySelector(NEXT_WEEK_SELECTOR);
    if (!nextWeekButton) {
      throw new Error("次の週へ移動するボタンが見つかりませんでした。");
    }

    nextWeekButton.click();
    await waitForWeekChange(previousDates, previousSchedule);
    button.textContent = `${weeks}週目を同期中...`;
  }

  return { totalCreated, weeks };
}

function addSyncButton() {
  const container = document.querySelector(".table-responsive .margin-bottom");
  if (!container || document.getElementById(BUTTON_ID)) {
    return;
  }

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = "Googleカレンダー同期";
  button.className = "btn btn-primary";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "同期中...";

    try {
      const result = await syncWeeks(button);
      alert(
        `${result.totalCreated}件の予定を${result.weeks}週分同期しました。`,
      );
      button.textContent = "同期完了";
    } catch (error) {
      alert(error instanceof Error ? error.message : "同期に失敗しました。");
      button.disabled = false;
      button.textContent = "Googleカレンダー同期";
    }
  });

  container.prepend(button);
}

function addCompletenessSettings() {
  const container = document.querySelector(".table-responsive .margin-bottom");
  if (!container || document.getElementById(SETTINGS_ID)) {
    return;
  }

  const label = document.createElement("label");
  label.id = SETTINGS_ID;
  label.style.cssText =
    "display:inline-flex;align-items:center;margin:0 0 0 8px;font-size:12px;vertical-align:middle;cursor:pointer;";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = showNonPerfectScores;
  checkbox.style.cssText = "margin:0 4px 0 0;position:relative;top:-1px;";
  const text = document.createTextNode("満点以外も表示");
  label.append(checkbox, text);
  checkbox.addEventListener("change", () => {
    showNonPerfectScores = checkbox.checked;
    completenessResults.clear();
    completenessReportDocument = null;
    saveCompletenessResults();
    closeCompletenessBubble();
    document.querySelectorAll(`.${CHECK_BUTTON_CLASS}`).forEach((button) => {
      delete button.dataset.incompleteCount;
      setCompletenessButtonState(button, "未提出確認");
    });
    chrome.storage.local.set({ showNonPerfectScores }).catch((error) => {
      console.warn("未提出確認の設定を保存できませんでした", error);
    });
  });
  container.append(label);

  const hiddenLabel = document.createElement("label");
  hiddenLabel.style.cssText =
    "display:inline-flex;align-items:center;margin:0 0 0 8px;font-size:12px;vertical-align:middle;cursor:pointer;";
  const hiddenCheckbox = document.createElement("input");
  hiddenCheckbox.type = "checkbox";
  hiddenCheckbox.checked = showHiddenCompletenessItems;
  hiddenCheckbox.style.cssText = "margin:0 4px 0 0;position:relative;top:-1px;";
  hiddenLabel.append(
    hiddenCheckbox,
    document.createTextNode("非表示項目を表示"),
  );
  hiddenCheckbox.addEventListener("change", () => {
    showHiddenCompletenessItems = hiddenCheckbox.checked;
    document.querySelectorAll(`.${CHECK_BUTTON_CLASS}`).forEach((button) => {
      applyCachedCompletenessResult(getButtonClassId(button));
    });
    closeCompletenessBubble();
  });
  container.append(hiddenLabel);

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.textContent = "非表示をすべて戻す";
  restoreButton.className = "btn btn-default";
  restoreButton.style.cssText =
    "margin-left:8px;padding:2px 6px;font-size:11px;vertical-align:middle;";
  restoreButton.addEventListener("click", () => {
    if (!hiddenCompletenessItems.size) {
      return;
    }
    if (!window.confirm("非表示にした項目をすべて表示に戻しますか？")) {
      return;
    }
    hiddenCompletenessItems.clear();
    saveHiddenCompletenessItems();
    document.querySelectorAll(`.${CHECK_BUTTON_CLASS}`).forEach((button) => {
      applyCachedCompletenessResult(getButtonClassId(button));
    });
    closeCompletenessBubble();
  });
  container.append(restoreButton);

  chrome.storage.local
    .get({ showNonPerfectScores: false })
    .then((settings) => {
      showNonPerfectScores = Boolean(settings.showNonPerfectScores);
      checkbox.checked = showNonPerfectScores;
    })
    .catch((error) => {
      console.warn("未提出確認の設定を読み込めませんでした", error);
    });
  chrome.storage.local
    .get({ [HIDDEN_ITEMS_STORAGE_KEY]: [] })
    .then((settings) => {
      hiddenCompletenessItems = new Set(
        settings[HIDDEN_ITEMS_STORAGE_KEY] || [],
      );
      document.querySelectorAll(`.${CHECK_BUTTON_CLASS}`).forEach((button) => {
        applyCachedCompletenessResult(getButtonClassId(button));
      });
    })
    .catch((error) => {
      console.warn("非表示項目の設定を読み込めませんでした", error);
    });
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      addSyncButton();
      addCompletenessSettings();
      startCompletenessButtonObserver();
      startCompletenessAutoCheck();
      loadCompletenessResults();
      startTodayClassDirectorySelection();
    },
    { once: true },
  );
} else {
  addSyncButton();
  addCompletenessSettings();
  startCompletenessButtonObserver();
  startCompletenessAutoCheck();
  loadCompletenessResults();
  startTodayClassDirectorySelection();
}
