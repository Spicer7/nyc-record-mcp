const BASE_URL = "https://data.cityofnewyork.us";
const DATASET_ID = "dg92-zbpx";

export type CityRecordNotice = {
  request_id?: string;
  start_date?: string;
  end_date?: string;
  agency_name?: string;
  type_of_notice_description?: string;
  category_description?: string;
  short_title?: string;
  selection_method_description?: string;
  section_name?: string;
  special_case_reason_description?: string;
  pin?: string;
  due_date?: string;
  address_to_request?: string;
  contact_name?: string;
  contact_phone?: string;
  email?: string;
  contract_amount?: string;
  contact_fax?: string;
  additional_description_1?: string;
  additional_description_2?: string;
  additional_description_3?: string;
  vendor_name?: string;
  vendor_address?: string;
  document_links?: string;
  event_date?: string;
  building_name?: string;
  street_address_1?: string;
  street_address_2?: string;
  city?: string;
  state?: string;
  zip_code?: string;
};

// Escape a value for interpolation into a SoQL string literal. Values must be
// plain text — buildUrl's URLSearchParams handles URL encoding, so anything
// pre-encoded (e.g. with encodeURIComponent) reaches Socrata double-encoded.
function escapeSoql(value: string): string {
  return value.replace(/'/g, "''");
}

function buildUrl(params: Record<string, string>): string {
  const url = new URL(`${BASE_URL}/resource/${DATASET_ID}.json`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const appToken = process.env.SOCRATA_APP_TOKEN;
  if (appToken) {
    url.searchParams.set("$$app_token", appToken);
  }
  return url.toString();
}

async function sodaFetch(params: Record<string, string>): Promise<CityRecordNotice[]> {
  const res = await fetch(buildUrl(params));
  if (!res.ok) {
    throw new Error(`NYC Open Data API error ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<CityRecordNotice[]>;
}

export async function searchNotices(
  query: string,
  limit = 25
): Promise<CityRecordNotice[]> {
  return sodaFetch({
    $q: query,
    $limit: String(limit),
    $order: "start_date DESC",
  });
}

export async function getNoticesByAgency(
  agencyName: string,
  limit = 25
): Promise<CityRecordNotice[]> {
  return sodaFetch({
    $where: `upper(agency_name) like upper('%${escapeSoql(agencyName)}%')`,
    $limit: String(limit),
    $order: "start_date DESC",
  });
}

export async function getNoticesByType(
  noticeType: string,
  limit = 25
): Promise<CityRecordNotice[]> {
  return sodaFetch({
    $where: `type_of_notice_description='${noticeType}'`,
    $limit: String(limit),
    $order: "start_date DESC",
  });
}

export async function getProcurementNotices(
  limit = 25
): Promise<CityRecordNotice[]> {
  return sodaFetch({
    $where:
      "type_of_notice_description in ('Solicitation','Award','Intent to Award','Intent to Negotiate','Vendor List')",
    $limit: String(limit),
    $order: "start_date DESC",
  });
}

export async function getPublicHearings(
  limit = 25
): Promise<CityRecordNotice[]> {
  return sodaFetch({
    $where:
      "type_of_notice_description in ('Public Hearings','Public Comment','Meeting','Notice')",
    $limit: String(limit),
    $order: "start_date DESC",
  });
}

export async function getOpenSolicitations(
  limit = 25
): Promise<CityRecordNotice[]> {
  const today = new Date().toISOString().split("T")[0];
  return sodaFetch({
    $where: `type_of_notice_description='Solicitation' AND due_date >= '${today}'`,
    $limit: String(limit),
    $order: "due_date ASC",
  });
}

export type AmountMention = {
  amount: string;
  context: string;
};

export type ProcurementSearchResult = CityRecordNotice & {
  amounts_in_description?: AmountMention[];
};

// Agencies like NYCHA often bundle several line awards into one Award notice,
// with per-development/per-line dollar figures only in the free-text
// description. Pull each figure out with surrounding context so callers get
// the breakdown, not just the top-line contract_amount.
export function extractAmountMentions(notice: CityRecordNotice): AmountMention[] {
  const mentions: AmountMention[] = [];
  const fields = [
    notice.additional_description_1,
    notice.additional_description_2,
    notice.additional_description_3,
  ];
  for (const text of fields) {
    if (!text) continue;
    const re = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = Math.max(0, match.index - 120);
      const end = Math.min(text.length, match.index + match[0].length + 40);
      mentions.push({
        amount: match[0].replace(/\s/g, ""),
        context: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return mentions;
}

export type AgencyProcurementOptions = {
  keywords?: string[];
  noticeType?: string;
  sinceDate?: string;
  untilDate?: string;
  limit?: number;
};

export async function searchAgencyProcurement(
  agency: string,
  options: AgencyProcurementOptions = {}
): Promise<ProcurementSearchResult[]> {
  const clauses = [`upper(agency_name) like upper('%${escapeSoql(agency)}%')`];

  const keywords = (options.keywords ?? []).filter((k) => k.trim().length > 0);
  if (keywords.length > 0) {
    const keywordClauses = keywords.flatMap((keyword) => {
      const escaped = escapeSoql(keyword);
      return [
        `upper(short_title) like upper('%${escaped}%')`,
        `upper(additional_description_1) like upper('%${escaped}%')`,
      ];
    });
    clauses.push(`(${keywordClauses.join(" OR ")})`);
  }
  if (options.noticeType) {
    clauses.push(`type_of_notice_description='${escapeSoql(options.noticeType)}'`);
  }
  if (options.sinceDate) {
    clauses.push(`start_date >= '${escapeSoql(options.sinceDate)}'`);
  }
  if (options.untilDate) {
    clauses.push(`start_date <= '${escapeSoql(options.untilDate)}'`);
  }

  const notices = await sodaFetch({
    $where: clauses.join(" AND "),
    $limit: String(options.limit ?? 100),
    $order: "start_date DESC",
  });

  return notices.map((notice) => {
    const amounts = extractAmountMentions(notice);
    return amounts.length > 0 ? { ...notice, amounts_in_description: amounts } : notice;
  });
}

export async function getNoticesByDateRange(
  startDate: string,
  endDate: string,
  limit = 50
): Promise<CityRecordNotice[]> {
  return sodaFetch({
    $where: `start_date >= '${startDate}' AND start_date <= '${endDate}'`,
    $limit: String(limit),
    $order: "start_date DESC",
  });
}
