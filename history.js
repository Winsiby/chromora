(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChromoraHistory = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  class PhotoHistory {
    constructor(limit = 100) {
      this.limit = limit;
      this.photos = new Map();
    }

    reset(photoId, snapshot) {
      if (photoId == null) return;
      this.photos.set(photoId, { undo: [], redo: [], current: clone(snapshot) });
    }

    resetAll(entries = []) {
      this.photos.clear();
      for (const [photoId, snapshot] of entries) this.reset(photoId, snapshot);
    }

    ensure(photoId, snapshot) {
      if (!this.photos.has(photoId)) this.reset(photoId, snapshot);
      return this.photos.get(photoId);
    }

    record(photoId, before, after) {
      if (photoId == null || equal(before, after)) return false;
      const entry = this.ensure(photoId, before);
      entry.undo.push(clone(before));
      if (entry.undo.length > this.limit) entry.undo.splice(0, entry.undo.length - this.limit);
      entry.redo.length = 0;
      entry.current = clone(after);
      return true;
    }

    undo(photoId, current) {
      const entry = this.photos.get(photoId);
      if (!entry || !entry.undo.length) return null;
      entry.redo.push(clone(current));
      if (entry.redo.length > this.limit) entry.redo.splice(0, entry.redo.length - this.limit);
      entry.current = clone(entry.undo.pop());
      return clone(entry.current);
    }

    redo(photoId, current) {
      const entry = this.photos.get(photoId);
      if (!entry || !entry.redo.length) return null;
      entry.undo.push(clone(current));
      if (entry.undo.length > this.limit) entry.undo.splice(0, entry.undo.length - this.limit);
      entry.current = clone(entry.redo.pop());
      return clone(entry.current);
    }

    canUndo(photoId) {
      return Boolean(this.photos.get(photoId)?.undo.length);
    }

    canRedo(photoId) {
      return Boolean(this.photos.get(photoId)?.redo.length);
    }
  }

  return { PhotoHistory, clone, equal };
});
