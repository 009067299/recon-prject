"use strict";

const RECORD_TYPES = [
  { name: "A", code: 1, description: "IPv4 addresses" },
  { name: "AAAA", code: 28, description: "IPv6 addresses" },
  { name: "MX", code: 15, description: "Mail exchange" },
  { name: "NS", code: 2, description: "Nameservers" },
  { name: "TXT", code: 16, description: "Text records" },
  { name: "CNAME", code: 5, description: "Canonical aliases" }
];
const form = document.querySelector("#recon-form");
const domainInput = document.querySelector("#domain");
const runButton = document.querySelector("#run-button");
const copyButton = document.querySelector("#copy-button");
const statusMessage = document.querySelector("#status");
const resultsSection = document.querySelector("#results");
const emptyState = document.querySelector("#empty-state");
let latestReport = null;
let lookupInProgress = false;
let copyResetTimer;
const dnsCheckbox = document.querySelector("#allow-dns");
const certificateButton = document.querySelector("#load-certificates");
const certificateStatus = document.querySelector("#certificate-status");
let workspaceDomain = "";
let certificateController = null;

// A previous browser form state must never silently opt the next run into DNS.
function resetDnsChoice() {
  dnsCheckbox.checked = false;
  document.querySelector("#auto-certificates").checked = false;
  if (!lookupInProgress) runButton.textContent = "Prepare research";
}
resetDnsChoice();
window.addEventListener("pageshow", resetDnsChoice);
dnsCheckbox.addEventListener("change", () => {
  runButton.textContent = dnsCheckbox.checked ? "Run DNS lookup" : "Prepare research";
});

function prepareWorkspace(domain) {
  if (certificateController) certificateController.abort();
  certificateController = null;
  workspaceDomain = domain;
  document.querySelector("#public-workspace").hidden = false;
  document.querySelector("#public-target").textContent = domain;
  document.querySelector("#certificate-results").replaceChildren();
  certificateStatus.textContent = "No provider contacted for this workspace.";
  certificateButton.disabled = false;
  document.querySelector("#certificate-link").href = `https://crt.sh/?q=${encodeURIComponent(domain)}`;
  document.querySelector("#icann-link").href = 'https://lookup.icann.org/en/lookup?name=' + encodeURIComponent(domain);
  document.querySelector("#urlscan-link").href = 'https://urlscan.io/search/#' + encodeURIComponent('page.domain:"' + domain + '"');
  document.querySelector("#virustotal-link").href = 'https://www.virustotal.com/gui/domain/' + encodeURIComponent(domain);
  document.querySelector("#archive-link").href = 'https://web.archive.org/web/*/' + encodeURIComponent(domain);
  document.querySelector("#research-hint").textContent = 'Five research links prepared for ' + domain + '. ICANN covers registration (use the registered domain if a subdomain is not found). Providers see opened searches. Use existing reports only; new scans, reanalysis, archive saves and live links can contact the target.';
}

async function readBoundedJson(response) {
  const limit = 2 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) throw new Error("large");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

function certificateDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "Unavailable";
}

certificateButton.addEventListener("click", async () => {
  if (!workspaceDomain || certificateController) return;
  const domain = workspaceDomain;
  const controller = new AbortController();
  certificateController = controller;
  certificateButton.disabled = true;
  certificateStatus.textContent = `Requesting existing certificate records for ${domain} from crt.sh…`;
  document.querySelector("#certificate-results").replaceChildren();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // No target URLs, scan endpoints, redirects, images, or follow-up DNS requests.
    const response = await fetch(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, {
      signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
      redirect: "error", cache: "no-store"
    });
    if (!response.ok) throw new Error(response.status === 429 ? "rate" : "unavailable");
    const data = await readBoundedJson(response);
    if (!Array.isArray(data)) throw new Error("unavailable");
    if (certificateController !== controller) return;
    const seen = new Set();
    const cards = [];
    let matching = 0;
    for (const record of data) {
      if (!record || typeof record.name_value !== "string") continue;
      const names = [...new Set(record.name_value.split(/\r?\n/).map(name => name.trim().toLowerCase())
        .filter(name => name === domain || name.endsWith(`.${domain}`)))];
      if (!names.length) continue;
      const issuer = typeof record.issuer_name === "string" ? record.issuer_name : "Unavailable";
      const from = certificateDate(record.not_before);
      const until = certificateDate(record.not_after);
      const serial = typeof record.serial_number === "string" ? record.serial_number : String(record.id || "");
      const key = `${issuer}|${serial}|${names.slice().sort().join(",")}|${from}|${until}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matching += 1;
      if (cards.length >= 100) continue;
      const card = element("article", "certificate-entry");
      card.append(element("p", "certificate-names", names.join("\n")),
        element("p", "certificate-meta", `Issuer: ${issuer}`),
        element("p", "certificate-meta", `Certificate validity: ${from} → ${until}`),
        element("p", "certificate-meta", `Log entry date: ${certificateDate(record.entry_timestamp)}`));
      cards.push(card);
    }
    document.querySelector("#certificate-results").replaceChildren(...cards);
    const collected = new Date().toISOString();
    certificateStatus.textContent = matching
      ? `Showing ${cards.length} of ${matching} distinct matching entries in this response. Retrieved ${collected}. Historical evidence only; current deployment and complete coverage are not verified.`
      : `No matching certificate records returned. Retrieved ${collected}. This does not prove that the domain has no certificates.`;
  } catch (error) {
    if (certificateController !== controller) return;
    certificateStatus.textContent = error.message === "large"
      ? "This certificate response is too large to display here. You can use the external Certificate Search link. No live DNS fallback was run."
      : error.message === "rate"
        ? "crt.sh rate-limited this request. Try again later. No automatic retry or live DNS fallback was run."
        : "Certificate records could not be loaded. The provider may be unavailable, the request timed out, or your browser blocked it. No live DNS fallback was run.";
  } finally {
    clearTimeout(timeout);
    if (certificateController === controller) {
      certificateController = null;
      certificateButton.disabled = false;
    }
  }
});

function normalizeDomain(value) {
  const domain = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  const labels = domain.split(".");
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  // Deliberately accept domain names only, not paths, ports, credentials, or IPs.
  if (domain.length > 253 || labels.length < 2 || domain === "localhost" ||
      domain.endsWith(".localhost") || /^\d+(?:\.\d+){3}$/.test(domain) ||
      !labels.every(label => validLabel.test(label)) ||
      !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels[labels.length - 1])) {
    throw new Error("Enter a valid domain such as example.com. Use a domain only, without a path or port.");
  }
  return domain;
}

function setStatus(message, tone = "neutral") {
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
}

async function lookupRecord(domain, type) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type.name}&edns_client_subnet=0.0.0.0%2F0`;
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error"
    });
    if (!response.ok) throw new Error("Request failed. Try again.");
    const data = await response.json();
    if (!data || typeof data !== "object" || !Number.isInteger(data.Status)) {
      throw new Error("The DNS service returned an unreadable response. Try again.");
    }
    if (data.Status === 3) return { records: [], state: "nxdomain" };
    if (data.Status !== 0) throw new Error("The DNS service could not resolve this record type. Try again.");
    if (data.TC === true) throw new Error("The DNS response was incomplete. Try again.");
    if (data.Answer !== undefined && !Array.isArray(data.Answer)) {
      throw new Error("The DNS service returned an unreadable response. Try again.");
    }
    const seen = new Set();
    // Answers can include CNAME chains. Only count the requested type in its card.
    const records = (data.Answer || []).filter(record => record && record.type === type.code &&
      typeof record.data === "string" && record.data.trim().length > 0).filter(record => {
      const key = `${typeof record.name === "string" ? record.name : domain}|${record.data}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(record => ({
      value: record.data,
      ttl: Number.isFinite(record.TTL) && record.TTL >= 0 ? String(record.TTL) : "unavailable"
    }));
    return { records, state: "ok" };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Request timed out. Try again.");
    if (error instanceof TypeError) throw new Error("Request failed. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderRecordCard(result) {
  const card = element("article", "panel record-card");
  const heading = element("div", "record-heading");
  const titleGroup = element("div");
  titleGroup.append(element("h3", "", `${result.type.name} Records`), element("small", "", result.type.description));
  const icon = element("span", "type-icon", result.type.name);
  icon.setAttribute("aria-hidden", "true");
  const count = element("span", "count", result.state === "failed" ? "!" : String(result.records.length));
  count.setAttribute("aria-label", result.state === "failed" ? "Lookup failed" : `${result.records.length} records`);
  heading.append(icon, titleGroup, count);
  card.append(heading);
  if (!result.records.length) {
    card.append(element("p", `record-empty${result.state === "failed" ? " failed" : ""}`,
      result.state === "failed" ? result.error : "No records returned."));
  } else {
    const list = element("ul", "record-list");
    for (const record of result.records) {
      const row = element("li");
      row.append(element("code", "record-value", record.value), element("span", "record-ttl", `TTL ${record.ttl}${record.ttl === "unavailable" ? "" : " s"}`));
      list.append(row);
    }
    card.append(list);
  }
  return card;
}

function renderResults(report) {
  document.querySelector("#target-value").textContent = report.domain;
  document.querySelector("#count-value").textContent = String(report.total);
  document.querySelector("#time-value").textContent = `${report.elapsed} ms`;
  document.querySelector("#record-grid").replaceChildren(...report.results.map(renderRecordCard));
  emptyState.hidden = true;
  resultsSection.hidden = false;
}

function makeReport(report) {
  const lines = ["ReconScope Passive Recon Report", `Target: ${report.domain}`,
    `DNS records found: ${report.total}`, `Lookup time: ${report.elapsed} ms`, ""];
  for (const result of report.results) {
    lines.push(`${result.type.name} Records`);
    if (result.state === "failed") lines.push(`Lookup failed: ${result.error}`);
    else if (result.state === "nxdomain") lines.push("No records returned. DNS reports that the domain does not exist.");
    else if (!result.records.length) lines.push("No records returned.");
    else result.records.forEach(record => lines.push(`${record.value} | TTL ${record.ttl}`));
    lines.push("");
  }
  lines.push("Source: Google Public DNS. TTL values are in seconds.", "Live recursive DNS was explicitly enabled for this run. The resolver may contact authoritative DNS servers.", "This report does not establish anonymous or undetectable research.", "Use only on authorized targets.");
  return lines.join("\n");
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A local file or denied Clipboard API may still allow user-initiated copying.
    }
  }
  const textarea = element("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand("copy"); }
  finally { textarea.remove(); copyButton.focus(); }
  if (!copied) throw new Error("Copy was blocked by your browser. Allow clipboard access, then try again.");
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (lookupInProgress) return;
  let domain;
  try {
    domain = normalizeDomain(domainInput.value);
  } catch (error) {
    domainInput.setAttribute("aria-invalid", "true");
    setStatus(error.message, "error");
    domainInput.focus();
    return;
  }
  domainInput.removeAttribute("aria-invalid");
  domainInput.value = domain;
  const allowLiveDns = dnsCheckbox.checked;
  const autoCertificates = document.querySelector("#auto-certificates").checked;
  resetDnsChoice();
  latestReport = null;
  clearTimeout(copyResetTimer);
  copyButton.textContent = "Copy Report";
  copyButton.disabled = true;
  document.querySelector("#copy-status").textContent = "";
  resultsSection.hidden = true;
  emptyState.hidden = true;
  prepareWorkspace(domain);
  if (autoCertificates) certificateButton.click();
  if (!allowLiveDns) {
    setStatus(autoCertificates ? `Workspace prepared for ${domain}. Selected certificate lookup started; other research links are ready.` : `Workspace prepared for ${domain}. No lookup requests sent. Choose a provider below to load existing records.`, "success");
    return;
  }
  lookupInProgress = true;
  dnsCheckbox.disabled = true;
  form.setAttribute("aria-busy", "true");
  runButton.disabled = true;
  domainInput.disabled = true;
  runButton.textContent = "Looking up…";
  if (!autoCertificates) certificateStatus.textContent = "Live DNS was enabled for this workspace. No certificate provider contacted yet.";
  setStatus(`Looking up six DNS record types for ${domain}…`);
  const start = performance.now();
  try {
    const settled = await Promise.allSettled(RECORD_TYPES.map(type => lookupRecord(domain, type)));
    const results = settled.map((result, index) => result.status === "fulfilled"
      ? { type: RECORD_TYPES[index], ...result.value }
      : { type: RECORD_TYPES[index], records: [], state: "failed", error: result.reason.message || "Lookup failed. Try again." });
    const failed = results.filter(result => result.state === "failed").length;
    const total = results.reduce((sum, result) => sum + result.records.length, 0);
    const report = { domain, results, total, elapsed: Math.round(performance.now() - start) };
    renderResults(report);
    latestReport = report;
    copyButton.disabled = false;
    if (failed === RECORD_TYPES.length) setStatus("The lookup could not be completed. Check your connection and try again.", "error");
    else if (failed) setStatus(`Partial results for ${domain}: ${total} records found; ${failed} record type${failed === 1 ? "" : "s"} could not be retrieved. Enable live DNS again to retry.`, "warning");
    else if (results.every(result => result.state === "nxdomain")) setStatus(`No records returned for ${domain}. DNS reports that this domain does not exist.`, "warning");
    else if (!total) setStatus(`Lookup complete for ${domain}. No records returned for the six requested types.`);
    else setStatus(`Lookup complete for ${domain}. ${total} records found across six record types.`, "success");
  } catch {
    setStatus("The lookup could not be completed. Check your connection and try again.", "error");
    emptyState.hidden = false;
  } finally {
    lookupInProgress = false;
    form.removeAttribute("aria-busy");
    runButton.disabled = false;
    domainInput.disabled = false;
    dnsCheckbox.disabled = false;
    resetDnsChoice();
  }
});

domainInput.addEventListener("input", () => domainInput.removeAttribute("aria-invalid"));
copyButton.addEventListener("click", async () => {
  if (!latestReport) return;
  const report = latestReport;
  const copyStatus = document.querySelector("#copy-status");
  clearTimeout(copyResetTimer);
  copyStatus.textContent = "";
  try {
    await copyText(makeReport(report));
    if (latestReport !== report) return;
    copyButton.textContent = "Copied";
    copyStatus.textContent = "Report copied to clipboard.";
    copyStatus.style.color = "var(--accent)";
    copyResetTimer = setTimeout(() => {
      copyButton.textContent = "Copy Report";
      copyStatus.textContent = "";
    }, 2200);
  } catch {
    if (latestReport !== report) return;
    copyStatus.style.color = "var(--error)";
    copyStatus.textContent = "Copy was blocked by your browser. Allow clipboard access, then try again.";
  }
});
