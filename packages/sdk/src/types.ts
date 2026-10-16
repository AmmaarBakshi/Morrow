export interface Items<T> {
  items: T[];
}

export interface Ok {
  ok: boolean;
}

/** Inclusive local dates (YYYY-MM-DD) in the workspace time zone. */
export interface Range {
  from?: string;
  to?: string;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}
