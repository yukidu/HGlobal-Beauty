(() => {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : String(input?.url || '');
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

    if (
      requestUrl.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      typeof init.body === 'string' &&
      !headers.has('Content-Type')
    ) {
      const body = init.body.trim();
      if (body.startsWith('{') || body.startsWith('[')) headers.set('Content-Type', 'application/json');
    }

    return nativeFetch(input, { ...init, headers });
  };

  async function enhanceAdminReports() {
    const content = document.querySelector('#content');
    if (!content || document.querySelector('#starbeautyReportTools')) return;
    const heading = content.querySelector('.section-head h2');
    if (!heading || !String(heading.textContent || '').includes('管理後台')) return;

    const card = document.createElement('section');
    card.id = 'starbeautyReportTools';
    card.className = 'card stack';
    card.innerHTML = `
      <div class="row">
        <div>
          <div class="title">統計與報表</div>
          <div id="starbeautyReportSummary" class="small">統計讀取中…</div>
        </div>
        <a class="btn ghost" href="/api/admin/reports/submissions.csv">匯出繳交報表 CSV</a>
      </div>
      <div id="starbeautyReportAttention" class="desc"></div>
    `;
    const grid = content.querySelector('.admin-grid');
    if (grid?.parentNode) grid.parentNode.insertBefore(card, grid.nextSibling);
    else content.appendChild(card);

    try {
      const response = await window.fetch('/api/admin/reports/overview', { credentials: 'include', cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '統計讀取失敗');
      const summary = card.querySelector('#starbeautyReportSummary');
      summary.textContent = `學員 ${Number(data.students || 0)} 人｜進行中作業 ${Number(data.activeAssignments || 0)} 份｜待審核 ${Number(data.pendingReview || 0)}｜需補件 ${Number(data.needsRevision || 0)}`;

      const attention = card.querySelector('#starbeautyReportAttention');
      const assignments = Array.isArray(data.assignments) ? data.assignments : [];
      const lowest = assignments
        .filter(item => Number(item.eligibleStudents || 0) > 0)
        .sort((a, b) => Number(a.completionRate || 0) - Number(b.completionRate || 0))[0];
      attention.textContent = lowest
        ? `目前繳交率最低：${lowest.title}（${lowest.completionRate}%；${lowest.submittedStudents}/${lowest.eligibleStudents}）`
        : '目前尚無可計算繳交率的作業。';
    } catch (error) {
      const summary = card.querySelector('#starbeautyReportSummary');
      summary.textContent = error instanceof Error ? error.message : '統計讀取失敗';
    }
  }

  const observer = new MutationObserver(() => enhanceAdminReports());
  observer.observe(document.body, { childList: true, subtree: true });
  queueMicrotask(enhanceAdminReports);
})();
