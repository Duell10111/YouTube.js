import { type InnerTubeClient } from './Misc.js';

export interface GetVideoInfoOptions {
  /**
   * InnerTube client.
   */
  client?: InnerTubeClient;
  /**
   * Proof of Origin token, bound to the video ID being requested.
   * If not provided, session bound token will be used.
   */
  po_token?: string;
  /**
   * Do not send the session's credentials with the player request.
   *
   * Required whenever `client` is one that does not accept them — YouTube answers
   * an authenticated request for such a client with HTTP 400. See
   * `Constants.AUTH_SUPPORTED_CLIENTS`.
   */
  skip_auth?: boolean;
}