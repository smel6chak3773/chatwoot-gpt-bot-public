export class MemoryState {
  constructor() {
    this.store = new Map();
  }

  get(conversationId) {
    return this.store.get(conversationId) || [];
  }

  set(conversationId, data) {
    this.store.set(conversationId, data);
  }

  clear(conversationId) {
    this.store.delete(conversationId);
  }
}
