export type DocGroup =
  | 'Start here'
  | 'Build & assemble'
  | 'Inspect & finish'
  | 'Workspace & files'
  | 'Beyond the desktop';

export interface DocImage {
  src: string;
  alt: string;
  caption: string;
}

export interface DocSection {
  id: string;
  title: string;
  paragraphs?: string[];
  steps?: string[];
  bullets?: string[];
  table?: { headers: string[]; rows: string[][] };
  code?: { language: string; value: string };
  note?: { title: string; text: string; tone?: 'tip' | 'warning' };
  image?: DocImage;
}

export interface DocArticle {
  id: string;
  title: string;
  description: string;
  group: DocGroup;
  icon: string;
  intro: string;
  image?: DocImage;
  sections: DocSection[];
  related: string[];
}
