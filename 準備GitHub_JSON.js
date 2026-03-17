// n8n Code 節點：準備 GitHub JSON
// 輸入來源：
//   - 「生成確定性 HTML 區塊」節點 → report 資料
//   - 「AI 生成分析摘要」節點 → quickDigest / marketMood
//
// 連線方式：「組裝Email」的輸出接到此節點（與「發送 Gmail」並行）

const htmlBlocksNode = $('生成確定性 HTML 區塊').first().json;
const report = htmlBlocksNode.report || {};

// 取得 AI 生成分析摘要 的輸出
const summaryInput = $('AI 生成分析摘要').first().json;
let creative = {};
try {
  if (summaryInput.output) {
    creative = typeof summaryInput.output === 'string'
      ? JSON.parse(summaryInput.output)
      : summaryInput.output;
  } else {
    creative = summaryInput;
  }
} catch (e) {
  creative = {};
}

// 合併 report + quickDigest/marketMood
const fullReport = {
  date: report.date || new Date().toISOString().split('T')[0],
  quickDigest: creative.quickDigest || [],
  marketMood: creative.marketMood || '',
  totalSources: report.totalSources || 0,
  bullishSignals: report.bullishSignals || [],
  bearishSignals: report.bearishSignals || [],
  monitorSignals: report.monitorSignals || [],
  keyInsights: report.keyInsights || [],
  riskAlerts: report.riskAlerts || [],
  upcomingCatalysts: report.upcomingCatalysts || [],
  episodeSummaries: (report.episodeSummaries || []).map(ep => ({
    podcast: ep.podcast || '',
    episode: ep.episode || '',
    episodeLink: ep.episodeLink || '',
    sentiment: ep.sentiment || '',
    oneLiner: ep.oneLiner || '',
    detailedSummary: ep.detailedSummary || '',
    highlights: ep.highlights || [],
    source: ep.source || 'podcast',
  })),
};

const jsonString = JSON.stringify(fullReport, null, 2);
const base64Content = Buffer.from(jsonString, 'utf-8').toString('base64');
const fileName = `${fullReport.date}.json`;

return [{
  json: {
    fileName,
    content: base64Content,
    date: fullReport.date,
  }
}];
