import type {
  Annotation,
  Attachment,
  Comment,
  ExternalLink,
  SavedView,
  Site,
  SiteBundle,
} from '$lib/types';
import { currentUser, demoBundle, demoSites } from './demo-data';

/**
 * What the UI needs from the backend. The demo implementation below keeps the data in memory
 * and in localStorage; the Go API will implement the same calls over HTTP.
 */
export interface Api {
  listSites(): Promise<Site[]>;
  getSite(siteId: string): Promise<SiteBundle | null>;
  saveAnnotation(annotation: Annotation): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  addComment(annotationId: string, body: string): Promise<Comment>;
  addLink(annotationId: string, link: Omit<ExternalLink, 'id'>): Promise<ExternalLink>;
  removeLink(annotationId: string, linkId: string): Promise<void>;
  uploadAttachment(annotationId: string, file: File): Promise<Attachment>;
  removeAttachment(annotationId: string, attachmentId: string): Promise<void>;
  saveView(view: SavedView): Promise<SavedView>;
  deleteView(id: string): Promise<void>;
}

const STORAGE_KEY = 'spatial-hub.demo.v1';

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 120));
}

class DemoApi implements Api {
  private bundle: SiteBundle;

  constructor() {
    this.bundle = demoBundle();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const { annotations, savedViews } = JSON.parse(saved) as SiteBundle;
        this.bundle.annotations = annotations;
        this.bundle.savedViews = savedViews;
      }
    } catch {
      // Storage may be unavailable or hold an older shape; start from the seed.
    }
  }

  private persist() {
    try {
      const { annotations, savedViews } = this.bundle;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ annotations, savedViews }));
    } catch {
      // Uploaded files can exceed the quota; the in-memory state still works.
    }
  }

  private annotation(id: string): Annotation {
    const found = this.bundle.annotations.find((a) => a.id === id);
    if (!found) throw new Error(`annotation ${id} not found`);
    return found;
  }

  private touch(annotation: Annotation) {
    annotation.updatedAt = new Date().toISOString();
    this.persist();
  }

  listSites() {
    return delay(structuredClone(demoSites));
  }

  getSite(siteId: string) {
    if (siteId !== this.bundle.site.id) return delay(null);
    return delay(structuredClone(this.bundle));
  }

  saveAnnotation(annotation: Annotation) {
    const index = this.bundle.annotations.findIndex((a) => a.id === annotation.id);
    const saved = structuredClone({ ...annotation, updatedAt: new Date().toISOString() });
    if (index < 0) this.bundle.annotations.push(saved);
    else this.bundle.annotations[index] = saved;
    this.persist();
    return delay(structuredClone(saved));
  }

  deleteAnnotation(id: string) {
    this.bundle.annotations = this.bundle.annotations.filter((a) => a.id !== id);
    this.persist();
    return delay(undefined);
  }

  addComment(annotationId: string, body: string) {
    const comment: Comment = {
      id: newId('c'),
      author: currentUser,
      body,
      createdAt: new Date().toISOString(),
    };
    const annotation = this.annotation(annotationId);
    annotation.comments.push(comment);
    this.touch(annotation);
    return delay(structuredClone(comment));
  }

  addLink(annotationId: string, link: Omit<ExternalLink, 'id'>) {
    const created = { ...link, id: newId('l') };
    const annotation = this.annotation(annotationId);
    annotation.links.push(created);
    this.touch(annotation);
    return delay(structuredClone(created));
  }

  removeLink(annotationId: string, linkId: string) {
    const annotation = this.annotation(annotationId);
    annotation.links = annotation.links.filter((l) => l.id !== linkId);
    this.touch(annotation);
    return delay(undefined);
  }

  async uploadAttachment(annotationId: string, file: File) {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const attachment: Attachment = {
      id: newId('f'),
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      url,
      uploadedBy: currentUser.name,
      uploadedAt: new Date().toISOString(),
    };
    const annotation = this.annotation(annotationId);
    annotation.attachments.push(attachment);
    this.touch(annotation);
    return delay(structuredClone(attachment));
  }

  removeAttachment(annotationId: string, attachmentId: string) {
    const annotation = this.annotation(annotationId);
    annotation.attachments = annotation.attachments.filter((f) => f.id !== attachmentId);
    this.touch(annotation);
    return delay(undefined);
  }

  saveView(view: SavedView) {
    this.bundle.savedViews = [
      ...this.bundle.savedViews.filter((v) => v.id !== view.id),
      structuredClone(view),
    ];
    this.persist();
    return delay(structuredClone(view));
  }

  deleteView(id: string) {
    this.bundle.savedViews = this.bundle.savedViews.filter((v) => v.id !== id);
    this.persist();
    return delay(undefined);
  }
}

let instance: Api | undefined;

export function api(): Api {
  instance ??= new DemoApi();
  return instance;
}

export { currentUser, newId };
