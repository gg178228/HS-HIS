// 구글 검색 URL의 q 파라미터가 바뀌면 두 지도 탭을 갱신합니다.
// 검색어는 외부 서버로 별도 전송하지 않으며 각 지도 사이트 검색 URL에만 사용됩니다.
const GOOGLE_HOSTS = new Set(['www.google.com', 'google.com', 'www.google.co.kr', 'google.co.kr']);
const STORAGE_KEY = 'mapTabIds';
const lastQueries = new Map();
const inFlight = new Map();

function extractQuery(url) {
  try {
    const u = new URL(url);
    if (!GOOGLE_HOSTS.has(u.hostname) || u.pathname !== '/search') return null;
    const q = u.searchParams.get('q');
    return q && q.trim() ? q.trim() : null;
  } catch { return null; }
}

async function getStoredIds() {
  const data = await chrome.storage.session.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function updateOrCreate(site, targetUrl, ids, sourceTabId) {
  const existingId = ids[site];
  if (existingId && existingId !== sourceTabId) {
    try {
      const tab = await chrome.tabs.get(existingId);
      if (tab && !tab.incognito) {
        await chrome.tabs.update(existingId, {url: targetUrl, active: false});
        return existingId;
      }
    } catch { /* 닫힌 탭이면 다시 만듭니다. */ }
  }
  const tab = await chrome.tabs.create({url: targetUrl, active: false});
  return tab.id;
}

async function syncMaps(query, sourceTabId) {
  // 빠른 연속 검색은 마지막 검색어만 처리합니다.
  const ids = await getStoredIds();
  const encoded = encodeURIComponent(query);
  const destinations = {
    naver: `https://map.naver.com/p/search/${encoded}`,
    kakao: `https://map.kakao.com/?q=${encoded}`
  };
  const nextIds = {...ids};
  // 병렬 갱신: 느린 지도 하나가 다른 지도 탭 생성을 막지 않습니다.
  const results = await Promise.allSettled(Object.entries(destinations).map(async ([site, url]) => {
    const id = await updateOrCreate(site, url, ids, sourceTabId);
    return [site, id];
  }));
  for (const r of results) if (r.status === 'fulfilled') nextIds[r.value[0]] = r.value[1];
  await chrome.storage.session.set({[STORAGE_KEY]: nextIds});
}

function processGoogleTab(tabId, url) {
  const query = extractQuery(url);
  if (!query) return;
  if (lastQueries.get(tabId) === query) return;
  lastQueries.set(tabId, query);
  // 같은 탭에서 연속으로 검색하면 이전 작업을 마친 뒤 최신 검색을 적용합니다.
  const previous = inFlight.get(tabId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    if (lastQueries.get(tabId) !== query) return;
    await syncMaps(query, tabId);
  }).catch(console.error);
  inFlight.set(tabId, task);
  task.finally(() => { if (inFlight.get(tabId) === task) inFlight.delete(tabId); });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) processGoogleTab(tabId, changeInfo.url);
  else if (changeInfo.status === 'complete' && tab.url) processGoogleTab(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => { lastQueries.delete(tabId); inFlight.delete(tabId); });
