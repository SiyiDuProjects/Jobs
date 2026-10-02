/** A semantic answer chosen by the rule layer, before any page mutation. */
export interface ControlAnswerSpec {
  tiers: string[][];
  topic?: string;
  answer?: string;
  query?: string;
  queries?: string[];
  append?: boolean;
  selections?: ControlAnswerSpec[];
  literal?: boolean;
  equals?: (label: string, answer: string) => boolean;
  select?: (labels: string[]) => string | null;
}
export interface ControlOption {
  value: string;
  label: string;
}
export interface ReadOptionsContext {
  answer?: string;
  answers?: string[];
  optionSpec?: ControlAnswerSpec;
  timeout?: number;
}
export interface ChoiceOptions {
  canProceed?: () => boolean;
  replace?: boolean;
  append?: boolean;
  query?: string;
  optionSpec?: ControlAnswerSpec;
  timeout?: number;
}
