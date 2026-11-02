const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDARS_URL = "https://www.googleapis.com/calendar/v3/calendars";
const CALENDAR_NAME = "スタログ授業";
const SYNC_MARKER = "stalog-calendar-sync";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "SYNC_SCHEDULE") {
    return false;
  }

  syncSchedule(message.events, message.weekStart, message.weekEnd)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function syncSchedule(events, weekStart, weekEnd) {
  if (!Array.isArray(events)) {
    throw new Error("予定データの形式が正しくありません。");
  }

  if (!weekStart || !weekEnd) {
    throw new Error("同期対象週の日付が指定されていません。");
  }

  const token = await chrome.identity.getAuthToken({ interactive: true });
  const accessToken = typeof token === "string" ? token : token?.token;
  if (!accessToken) {
    throw new Error("Googleのアクセストークンを取得できませんでした。");
  }

  const calendarId = await getOrCreateCalendar(accessToken);
  const eventsUrl = `${CALENDARS_URL}/${encodeURIComponent(calendarId)}/events`;
  const deleted = await deleteSyncedEvents(
    accessToken,
    eventsUrl,
    weekStart,
    weekEnd
  );
  let created = 0;
  for (const event of events) {
    const response = await fetch(eventsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        summary: event.summary,
        location: event.location || undefined,
        start: {
          dateTime: event.start,
          timeZone: "Asia/Tokyo"
        },
        end: {
          dateTime: event.end,
          timeZone: "Asia/Tokyo"
        },
        extendedProperties: {
          private: {
            syncSource: SYNC_MARKER
          }
        }
      })
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Google Calendar APIエラー (${response.status}): ${details}`);
    }

    created += 1;
  }

  return { created, deleted };
}

async function getOrCreateCalendar(accessToken) {
  const params = new URLSearchParams({
    minAccessRole: "owner",
    showDeleted: "false",
    maxResults: "250"
  });
  const listResponse = await fetch(`${CALENDAR_LIST_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!listResponse.ok) {
    const details = await listResponse.text();
    throw new Error(`カレンダー一覧の取得に失敗しました (${listResponse.status}): ${details}`);
  }

  const calendars = await listResponse.json();
  const existing = (calendars.items || []).find(
    (calendar) => calendar.summary === CALENDAR_NAME
  );
  if (existing?.id) {
    return existing.id;
  }

  const createResponse = await fetch(CALENDARS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: CALENDAR_NAME,
      timeZone: "Asia/Tokyo"
    })
  });

  if (!createResponse.ok) {
    const details = await createResponse.text();
    throw new Error(`専用カレンダーの作成に失敗しました (${createResponse.status}): ${details}`);
  }

  const createdCalendar = await createResponse.json();
  if (!createdCalendar.id) {
    throw new Error("作成した専用カレンダーのIDを取得できませんでした。");
  }
  return createdCalendar.id;
}

async function deleteSyncedEvents(accessToken, eventsUrl, weekStart, weekEnd) {
  const endDate = new Date(`${weekEnd}T00:00:00+09:00`);
  endDate.setDate(endDate.getDate() + 1);
  const params = new URLSearchParams({
    privateExtendedProperty: `syncSource=${SYNC_MARKER}`,
    timeMin: `${weekStart}T00:00:00+09:00`,
    timeMax: endDate.toISOString()
  });
  const response = await fetch(`${eventsUrl}?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`既存予定の検索に失敗しました (${response.status}): ${details}`);
  }

  const data = await response.json();
  let deleted = 0;
  for (const event of data.items || []) {
    const deleteResponse = await fetch(
      `${eventsUrl}/${encodeURIComponent(event.id)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const details = await deleteResponse.text();
      throw new Error(
        `既存予定の削除に失敗しました (${deleteResponse.status}): ${details}`
      );
    }
    deleted += 1;
  }

  return deleted;
}
