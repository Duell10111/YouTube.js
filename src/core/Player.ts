import type { FetchFunction, ICache } from '../types/index.js';
import { Constants, BinarySerializer, Log } from '../utils/index.js';

import {
  getRandomUserAgent,
  getStringBetweenStrings,
  getNsigProcessorFnBatch,
  Platform,
  PlayerError
} from '../utils/Utils.js';

import { JsExtractor, JsAnalyzer } from '../utils/index.js';
import { nsigMatcher, timestampMatcher } from '../utils/javascript/matchers.js';

import type { ExtractionConfig } from '../utils/javascript/JsAnalyzer.js';
import type { BuildScriptResult } from '../utils/javascript/JsExtractor.js';

import packageInfo from '../../package.json' with { type: 'json' };

const TAG = 'Player';

interface SerializablePlayer {
  playerId: string;
  signatureTimestamp: number;
  libraryVersion: string;
  data?: BuildScriptResult;
}

interface PlayerInitializationOptions {
  cache?: ICache;
  signature_timestamp: number;
  data: BuildScriptResult;
}

/**
 * Represents YouTube's player script. This is required to decipher signatures.
 */
interface NsigEvalArgs {
  sig?: string | null;
  n?: string | null;
  sp?: string | null;
}

interface PreparedUrl {
  url_components: URL;
  eval_args?: NsigEvalArgs;
}

export default class Player {
  public po_token?: string;

  constructor(public player_id: string, public signature_timestamp: number, public data?: BuildScriptResult) { /** no-op */ }

  public static async create(
    cache: ICache | undefined,
    fetch: FetchFunction = Platform.shim.fetch,
    po_token?: string, player_id?: string
  ): Promise<Player> {
    if (!player_id) {
      const url = new URL('/iframe_api', Constants.URLS.YT_BASE);
      const res = await fetch(url);

      if (!res.ok)
        throw new PlayerError(`Failed to get player id: ${res.status} (${res.statusText})`);

      const js = await res.text();

      player_id = getStringBetweenStrings(js, 'player\\/', '\\/');
    }

    Log.info(TAG, `Using player id (${player_id}). Checking for cached players..`);

    if (!player_id)
      throw new PlayerError('Failed to get player id');

    // We have the player id, now we can check if we have a cached player.
    if (cache) {
      const cached_player = await Player.fromCache(cache, player_id);
      if (cached_player) {
        Log.info(TAG, 'Found up-to-date player data in cache.');
        cached_player.po_token = po_token;
        return cached_player;
      }
    }

    const player_url = new URL(`/s/player/${player_id}/player_es6.vflset/en_US/base.js`, Constants.URLS.YT_BASE);

    Log.info(TAG, `Could not find any cached player. Will download a new player from ${player_url}.`);

    const player_res = await fetch(player_url, {
      headers: {
        'user-agent': getRandomUserAgent('desktop')
      }
    });

    if (!player_res.ok) {
      throw new PlayerError(`Failed to get player data: ${player_res.status}`);
    }

    const player_js = await player_res.text();

    const nsigFunctionName = 'nsigFunction';
    const timestampVarName = 'signatureTimestampVar';

    const extractions: ExtractionConfig[] = [
      { friendlyName: nsigFunctionName, match: nsigMatcher },
      { friendlyName: timestampVarName, match: timestampMatcher, collectDependencies: false }
    ];

    const jsAnalyzer = new JsAnalyzer(player_js, { extractions });
    const jsExtractor = new JsExtractor(jsAnalyzer);

    const result = jsExtractor.buildScript({
      disallowSideEffectInitializers: true,
      exportRawValues: true,
      rawValueOnly: [ timestampVarName ]
    });

    if (result.exportedRawValues && !(timestampVarName in result.exportedRawValues)) {
      Log.warn(TAG, 'Failed to extract signature timestamp.');
    }

    if (!result.exported.includes(nsigFunctionName)) {
      Log.warn(TAG, 'Failed to extract n/sig decipher function.');
    }

    const signatureTimestamp = result.exportedRawValues?.[timestampVarName];

    const player = await Player.fromSource(player_id, {
      cache,
      signature_timestamp: parseInt(signatureTimestamp) || 0,
      data: result
    });

    player.po_token = po_token;

    return player;
  }

  async decipher(url?: string, signature_cipher?: string, cipher?: string, this_response_nsig_cache?: Map<string, string>): Promise<string> {
    const [ result ] = await this.decipherMany([ { url, signature_cipher, cipher } ], this_response_nsig_cache);
    return result;
  }

  /**
   * Deciphers several URLs with a single call into the JavaScript runtime.
   *
   * Generating a manifest means deciphering every format of a video, and each
   * call into the runtime is expensive — on React Native that dominates the cost
   * of building a manifest. This batches all outstanding n/sig challenges of the
   * given URLs into one evaluation.
   *
   * @param inputs - URLs to decipher, in the shape a {@link Misc.Format} exposes them.
   * @param this_response_nsig_cache - Shared nsig cache, usually one per player response.
   */
  async decipherMany(
    inputs: { url?: string, signature_cipher?: string, cipher?: string }[],
    this_response_nsig_cache?: Map<string, string>
  ): Promise<string[]> {
    const prepared = inputs.map((input) => this.#prepare(input, this_response_nsig_cache));

    const pending = prepared.filter((item) => item.eval_args);

    if (pending.length && this.data) {
      const results = await this.#evaluateBatch(pending.map((item) => item.eval_args as NsigEvalArgs));

      for (let i = 0; i < pending.length; i++) {
        this.#applyEvalResult(pending[i], results[i], this_response_nsig_cache);
      }
    }

    return prepared.map((item) => this.#finalize(item.url_components));
  }

  /**
   * Splits a URL into its components and works out which n/sig challenges still
   * need the player script. Cache hits are applied right away.
   */
  #prepare(
    input: { url?: string, signature_cipher?: string, cipher?: string },
    this_response_nsig_cache?: Map<string, string>
  ): PreparedUrl {
    const { signature_cipher, cipher } = input;
    const url = input.url || signature_cipher || cipher;

    if (!url)
      throw new PlayerError('No valid URL to decipher');

    const args = new URLSearchParams(url);
    const url_components = new URL(args.get('url') || url);

    const n = url_components.searchParams.get('n');
    const s = args.get('s');
    const sp = args.get('sp');

    const prepared: PreparedUrl = { url_components };

    if (this.data && ((signature_cipher || cipher) || n)) {
      const eval_args: NsigEvalArgs = {};

      if (signature_cipher || cipher) {
        eval_args.sig = s;
        eval_args.sp = sp;
      }

      if (n) {
        const cached = this_response_nsig_cache?.get(n);
        if (cached !== undefined) {
          url_components.searchParams.set('n', cached);
        } else {
          eval_args.n = n;
        }
      }

      if (Object.keys(eval_args).length > 0) {
        prepared.eval_args = eval_args;
      }
    }

    return prepared;
  }

  /** Runs one evaluation for all outstanding challenges and returns a result per input. */
  async #evaluateBatch(eval_args: NsigEvalArgs[]): Promise<Record<string, unknown>[]> {
    // Shallow copy to avoid mutating the original data.
    const data = { ...this.data } as BuildScriptResult;

    // The processor takes the cipher's `s` parameter, which is carried as `sig` here.
    data.output = `${data.output}\n${getNsigProcessorFnBatch(
      eval_args.map((args) => ({ n: args.n, sp: args.sp, s: args.sig }))
    )}`;

    const result = await Platform.shim.eval(data, {}) as unknown;

    if (!Array.isArray(result) || result.length !== eval_args.length) {
      throw new PlayerError('Got invalid result from player script evaluation.');
    }

    return result as Record<string, unknown>[];
  }

  #applyEvalResult(
    prepared: PreparedUrl,
    result: Record<string, unknown> | undefined,
    this_response_nsig_cache?: Map<string, string>
  ): void {
    const eval_args = prepared.eval_args as NsigEvalArgs;
    const url_components = prepared.url_components;

    if (typeof result !== 'object' || result === null) {
      throw new PlayerError('Got invalid result from player script evaluation.');
    }

    if (typeof eval_args.sig === 'string') {
      const signatureResult = result.sig;

      Log.info(TAG, `Transformed signature from ${eval_args.sig} to ${signatureResult}.`);

      if (typeof signatureResult !== 'string')
        throw new PlayerError('Got invalid signature from player script evaluation.');

      if (eval_args.sp) {
        url_components.searchParams.set(eval_args.sp, signatureResult);
      } else {
        url_components.searchParams.set('signature', signatureResult);
      }
    }

    if (typeof eval_args.n === 'string') {
      const nResult = result.n;
      Log.info(TAG, `Transformed n from ${eval_args.n} to ${nResult}.`);

      if (typeof nResult !== 'string')
        throw new PlayerError('Failed to decipher nsig');

      if (nResult.startsWith('enhanced_except_')) {
        Log.warn(TAG, `Decipher script returned an error (n=${eval_args.n}):`, nResult);
      } else if (this_response_nsig_cache) {
        this_response_nsig_cache.set(eval_args.n, nResult);
      }

      url_components.searchParams.set('n', nResult);
    }
  }

  /** Adds the PoToken and client version params every streaming URL needs. */
  #finalize(url_components: URL): string {
    // @NOTE: SABR requests should include the PoToken (not base64d, but as bytes!) in the payload.
    if (url_components.searchParams.get('sabr') !== '1' && this.po_token)
      url_components.searchParams.set('pot', this.po_token);

    const client = url_components.searchParams.get('c');

    switch (client) {
      case 'WEB':
        url_components.searchParams.set('cver', Constants.CLIENTS.WEB.VERSION);
        break;
      case 'MWEB':
        url_components.searchParams.set('cver', Constants.CLIENTS.MWEB.VERSION);
        break;
      case 'WEB_REMIX':
        url_components.searchParams.set('cver', Constants.CLIENTS.YTMUSIC.VERSION);
        break;
      case 'WEB_KIDS':
        url_components.searchParams.set('cver', Constants.CLIENTS.WEB_KIDS.VERSION);
        break;
      case 'TVHTML5':
        url_components.searchParams.set('cver', Constants.CLIENTS.TV.VERSION);
        break;
      case 'TVHTML5_SIMPLY':
        url_components.searchParams.set('cver', Constants.CLIENTS.TV_SIMPLY.VERSION);
        break;
      case 'TVHTML5_SIMPLY_EMBEDDED_PLAYER':
        url_components.searchParams.set('cver', Constants.CLIENTS.TV_EMBEDDED.VERSION);
        break;
      case 'WEB_EMBEDDED_PLAYER':
        url_components.searchParams.set('cver', Constants.CLIENTS.WEB_EMBEDDED.VERSION);
        break;
    }

    const result = url_components.toString();

    Log.info(TAG, `Deciphered URL: ${result}`);

    return result;
  }

  static async fromCache(cache: ICache, player_id: string): Promise<Player | null> {
    const buffer = await cache.get(player_id);

    if (!buffer)
      return null;

    try {
      const deserializedCache = BinarySerializer.deserialize<SerializablePlayer>(new Uint8Array(buffer));

      if (deserializedCache.libraryVersion !== packageInfo.version) {
        Log.warn(TAG, `Cached player data is from a different library version (${deserializedCache.libraryVersion}). Ignoring it.`);
        return null;
      }

      return new Player(deserializedCache.playerId, deserializedCache.signatureTimestamp, deserializedCache.data);
    } catch (e) {
      Log.error(TAG, 'Failed to deserialize player data from cache:', e);
      return null;
    }
  }

  static async fromSource(player_id: string, options: PlayerInitializationOptions): Promise<Player> {
    const player = new Player(player_id, options.signature_timestamp, options.data);
    await player.cache(options.cache);
    return player;
  }

  async cache(cache?: ICache): Promise<void> {
    if (!cache || !this.data)
      return;

    const buffer = BinarySerializer.serialize({
      playerId: this.player_id,
      signatureTimestamp: this.signature_timestamp,
      libraryVersion: packageInfo.version,
      data: this.data
    });

    await cache.set(this.player_id, buffer);
  }

  get url(): string {
    return new URL(`/s/player/${this.player_id}/player_ias.vflset/en_US/base.js`, Constants.URLS.YT_BASE).toString();
  }

  static get LIBRARY_VERSION(): number {
    return 14;
  }
}