/**
 * One-shot requests from outside a view (command palette, chat), consumed by
 * the board or team view when it mounts or next renders.
 */
class BoardIntents {
  /** Open the new-card form on the board of this project. */
  newCard = $state<string | undefined>();
  /** Open the teammate dialog on the team screen of this project. */
  newTeammate = $state<string | undefined>();

  takeNewCard(workspaceId: string): boolean {
    if (this.newCard !== workspaceId) return false;
    this.newCard = undefined;
    return true;
  }

  takeNewTeammate(workspaceId: string): boolean {
    if (this.newTeammate !== workspaceId) return false;
    this.newTeammate = undefined;
    return true;
  }
}

export const boardIntents = new BoardIntents();
