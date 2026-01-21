import path from "node:path";
import { REPO_ROOT } from "../config.js";

export type TemplateTextLayout = {
  xPct: number;
  yPct: number;
  sizePct: number;
  color: string;
};

export type TemplateDefinition = {
  id: string;
  label: string;
  filePath: string;
  align: "left" | "center" | "right";
  title: TemplateTextLayout;
  subtitle?: TemplateTextLayout;
};

const TEMPLATE_ROOT = path.join(REPO_ROOT, "1920x1080");

const DEFAULT_TITLE: TemplateTextLayout = {
  xPct: 0.08,
  yPct: 0.38,
  sizePct: 0.32,
  color: "#f5f2ea",
};

const DEFAULT_SUBTITLE: TemplateTextLayout = {
  xPct: 0.08,
  yPct: 0.68,
  sizePct: 0.2,
  color: "#d1c7b8",
};

const CENTER_TITLE: TemplateTextLayout = {
  xPct: 0.5,
  yPct: 0.42,
  sizePct: 0.3,
  color: "#f5f2ea",
};

const CENTER_SUBTITLE: TemplateTextLayout = {
  xPct: 0.5,
  yPct: 0.7,
  sizePct: 0.2,
  color: "#d1c7b8",
};

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "card-lower-third-left",
    label: "Lower Third Left",
    filePath: path.join(TEMPLATE_ROOT, "card-lower-third-left-1920x1080.png"),
    align: "left",
    title: DEFAULT_TITLE,
    subtitle: DEFAULT_SUBTITLE,
  },
  {
    id: "card-lower-third-right",
    label: "Lower Third Right",
    filePath: path.join(TEMPLATE_ROOT, "card-lower-third-right-1920x1080.png"),
    align: "left",
    title: DEFAULT_TITLE,
    subtitle: DEFAULT_SUBTITLE,
  },
  {
    id: "card-lower-third-center",
    label: "Lower Third Center",
    filePath: path.join(TEMPLATE_ROOT, "card-lower-third-center-1920x1080.png"),
    align: "center",
    title: CENTER_TITLE,
    subtitle: CENTER_SUBTITLE,
  },
  {
    id: "card-top-third-left",
    label: "Top Third Left",
    filePath: path.join(TEMPLATE_ROOT, "card-top-third-left-1920x1080.png"),
    align: "left",
    title: DEFAULT_TITLE,
    subtitle: DEFAULT_SUBTITLE,
  },
  {
    id: "card-top-third-right",
    label: "Top Third Right",
    filePath: path.join(TEMPLATE_ROOT, "card-top-third-right-1920x1080.png"),
    align: "left",
    title: DEFAULT_TITLE,
    subtitle: DEFAULT_SUBTITLE,
  },
  {
    id: "card-title-top",
    label: "Title Top",
    filePath: path.join(TEMPLATE_ROOT, "card-title-top-1920x1080.png"),
    align: "center",
    title: CENTER_TITLE,
  },
  {
    id: "card-callout-right",
    label: "Callout Right",
    filePath: path.join(TEMPLATE_ROOT, "card-callout-right-1920x1080.png"),
    align: "left",
    title: DEFAULT_TITLE,
    subtitle: DEFAULT_SUBTITLE,
  },
  {
    id: "card-chapter-center",
    label: "Chapter Center",
    filePath: path.join(TEMPLATE_ROOT, "card-chapter-center-1920x1080.png"),
    align: "center",
    title: CENTER_TITLE,
    subtitle: CENTER_SUBTITLE,
  },
  {
    id: "card-corner-tag-top-right",
    label: "Corner Tag Top Right",
    filePath: path.join(TEMPLATE_ROOT, "card-corner-tag-top-right-1920x1080.png"),
    align: "right",
    title: {
      xPct: 0.92,
      yPct: 0.5,
      sizePct: 0.22,
      color: "#f5f2ea",
    },
  },
  {
    id: "card-bug-bottom-right",
    label: "Bug Bottom Right",
    filePath: path.join(TEMPLATE_ROOT, "card-bug-bottom-right-1920x1080.png"),
    align: "right",
    title: {
      xPct: 0.9,
      yPct: 0.6,
      sizePct: 0.2,
      color: "#f5f2ea",
    },
  },
];

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

export function listTemplates(): TemplateDefinition[] {
  return TEMPLATES;
}

export const DEFAULT_TEMPLATE_ID = "card-lower-third-left";
