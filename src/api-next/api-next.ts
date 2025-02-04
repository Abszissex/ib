import { Observable, Subject } from "rxjs";
import { map, take } from "rxjs/operators";
import { Contract, ContractDetails, ErrorCode, EventName } from "../";
import LogLevel from "../api/data/enum/log-level";
import {
  AccountSummaryValue,
  ConnectionState,
  IBApiNextError,
  IBApiTickType,
  MarketDataTick,
  MarketDataType,
  PnL,
  PnLSingle,
  AccountSummariesUpdate,
  AccountPositionsUpdate,
  Position,
  ContractDetailsUpdate,
  MarketDataUpdate,
  IBApiNextTickType,
} from "./";
import { ConsoleLogger } from "../core/api-next/console-logger";
import { Logger } from "./common/logger";
import { IBApiNextSubscription } from "../core/api-next/subscription";
import { IBApiNextSubscriptionRegistry } from "../core/api-next/subscription-registry";
import {
  MutableAccountSummaryTagValues,
  MutableAccountSummaryValues,
  MutableAccountSummaries,
} from "../core/api-next/api/account/mutable-account-summary";
import { MutableAccountPositions } from "../core/api-next/api/position/mutable-account-positions-update";
import { MutableMarketData } from "../core/api-next/api/market/mutable-market-data";
import { IBApiNextLogger } from "../core/api-next/logger";
import { IBApiAutoConnection } from "../core/api-next/auto-connection";

/**
 * @internal
 *
 * An invalid request id.
 */
const INVALID_REQ_ID = -1;

/**
 * @internal
 *
 * Log tag used on messages created by IBApiNext.
 */
const LOG_TAG = "IBApiNext";

/**
 * @internal
 *
 * Log tag used on messages that have been received from TWS / IB Gateway.
 */
const TWS_LOG_TAG = "TWS";

/**
 * @internal
 *
 * Returns undefined is the value is Number.MAX_VALUE, or the value otherwise.
 */
function undefineMax(v: number | undefined): number | undefined {
  return v === undefined || v === Number.MAX_VALUE ? undefined : v;
}

/**
 * Input arguments on the [[IBApiNext]] constructor.
 */
export interface IBApiNextCreationOptions {
  /**
   * Hostname of the TWS (or IB Gateway).
   *
   * Default is 'localhost'.
   */
  host?: string;

  /**
   * Hostname of the TWS (or IB Gateway).
   *
   * Default is 7496, which is the default setting on TWS for live-accounts.
   */
  port?: number;

  /**
   * The auto-reconnect interval in milliseconds.
   * If 0 or undefined, auto-reconnect will be disabled.
   */
  reconnectInterval?: number;

  /**
   * Custom logger implementation.
   *
   * By default [[IBApiNext]] does log to console.
   * If you want to log to a different target (i.e. a file or pipe),
   * set this attribute to your custom [[IBApiNextLogger]] implementation.
   */
  logger?: Logger;
}

/**
 * Next-gen Typescript implementation of the Interactive Brokers TWS (or IB Gateway) API.
 *
 * If you prefer to stay as close as possible to the official TWS API interfaces and functionality,
 * use [[IBApi]].
 *
 * If you prefer to use an API that provides some more convenience functions, such as auto-reconnect
 * or RxJS Observables that stay functional during re-connect, use [[IBApiNext]].
 *
 * [[IBApiNext]] does return RxJS Observables on most of the functions.
 * The first subscriber will send the request to TWS, while the last un-subscriber will cancel it.
 * Any subscriber in between will get a replay of the latest received value(s).
 * This is also the case if you call same function with same arguments multiple times ([[IBApiNext]]
 * will make sure that a similar subscription is not requested multiple times from TWS, but it will
 * become a new observers to the existing subscription).
 * In case of an error, a re-subscribe will send the TWS request again (it is fully compatible to RxJS
 * operators, e.g. retry or retryWhen).
 *
 * Note that connection errors are not reported to the returned Observables as returned by get-functions,
 * but they will simply stop emitting values until TWS connection is re-established.
 * Use [[IBApiNext.connectState]] for observing the connection state.
 */
export class IBApiNext {
  /**
   * Create an [[IBApiNext]] object.
   *
   * @param options Creation options.
   */
  constructor(options?: IBApiNextCreationOptions) {
    this.logger = new IBApiNextLogger(options?.logger ?? new ConsoleLogger());

    // create the IBApiAutoConnection and subscription registry

    this.api = new IBApiAutoConnection(
      options?.reconnectInterval ?? 0,
      this.logger,
      options
    );
    this.subscriptions = new IBApiNextSubscriptionRegistry(this.api, this);

    // setup error event handler (bound to lifetime of IBApiAutoConnection so we never unregister)

    this.api.on(
      EventName.error,
      (error: Error, code: ErrorCode, reqId: number) => {
        const apiError: IBApiNextError = { error, code, reqId };
        // emit to the subscription subject
        if (reqId !== INVALID_REQ_ID) {
          this.subscriptions.dispatchError(reqId, apiError);
        }
        // emit to global error subject
        this.errorSubject.next(apiError);
      }
    );

    // setup TWS server version event handler  (bound to lifetime of IBApiAutoConnection so we never unregister)

    this.api.on(EventName.server, (version, connectionTime) => {
      this.logger.info(
        TWS_LOG_TAG,
        `Server Version: ${version}. Connection time ${connectionTime}`
      );
    });

    // setup TWS info message event handler  (bound to lifetime of IBApiAutoConnection so we never unregister)

    this.api.on(EventName.info, (message: string) => {
      this.logger.info(TWS_LOG_TAG, message);
    });
  }

  /** The [[IBApiNextLogger]] instance. */
  public readonly logger: IBApiNextLogger;

  /** The [[IBApi]] with auto-reconnect. */
  private readonly api: IBApiAutoConnection;

  /** The subscription registry. */
  private readonly subscriptions: IBApiNextSubscriptionRegistry;

  /**
   * @internal
   * The next unused request id.
   * For internal use only.
   */
  get nextReqId(): number {
    return this._nextReqId++;
  }

  private _nextReqId = 1;

  /**
   * The IBApi error [[Subject]].
   *
   * All errors from [[IBApi]] error events will be sent to this subject.
   */
  public readonly errorSubject = new Subject<IBApiNextError>();

  /** Get the current log level. */
  get logLevel(): LogLevel {
    return this.logger.logLevel;
  }

  /** Set the current log level. */
  set logLevel(level: LogLevel) {
    this.logger.logLevel = level;
    this.api.setServerLogLevel(level);
  }

  /**
   * Get an [[Observable]] to receive errors on IB API.
   *
   * Errors that have a valid request id, will additionally be sent to
   * the observers of the request.
   */
  get error(): Observable<IBApiNextError> {
    return this.errorSubject;
  }

  /**
   * Get an [[Observable]] for observing the connection-state.
   */
  get connectionState(): Observable<ConnectionState> {
    return this.api.connectionState;
  }

  /** Returns true if currently connected, false otherwise. */
  get isConnected(): boolean {
    return this.api.isConnected;
  }

  /**
   * Connect to the TWS or IB Gateway.
   *
   * @param clientId A fixed client id to be used on all connection
   * attempts. If not specified, the first connection will use the
   * default client id (0) and increment it with each re-connection
   * attempt.
   *
   * @sse [[connectionState]] for observing the connection state.
   */
  connect(clientId?: number): IBApiNext {
    this.logger.debug(LOG_TAG, `connect(${clientId})`);
    this.api.connect(clientId);
    return this;
  }

  /**
   * Disconnect from the TWS or IB Gateway.
   *
   * Use [[connectionState]] for observing the connection state.
   */
  disconnect(): IBApiNext {
    this.logger.debug(LOG_TAG, "disconnect()");
    this.api.disconnect();
    return this;
  }

  /** currentTime event handler.  */
  private onCurrentTime = (
    subscriptions: Map<number, IBApiNextSubscription<number>>,
    time: number
  ): void => {
    subscriptions.forEach((sub) => sub.next({ all: time }));
  };

  /**
   * Get TWS's current time.
   */
  getCurrentTime(): Promise<number> {
    return this.subscriptions
      .register<number>(
        () => {
          this.api.reqCurrentTime();
        },
        undefined,
        [[EventName.currentTime, this.onCurrentTime]]
      )
      .pipe(
        take(1),
        map((v) => v.all)
      )
      .toPromise();
  }

  /** managedAccounts event handler.  */
  private onManagedAccts = (
    subscriptions: Map<number, IBApiNextSubscription<string[]>>,
    accountsList: string
  ): void => {
    const accounts = accountsList.split(",");
    subscriptions.forEach((sub) => sub.next({ all: accounts }));
  };

  /**
   * Get the accounts to which the logged user has access to.
   */
  getManagedAccounts(): Promise<string[]> {
    return this.subscriptions
      .register<string[]>(
        () => {
          this.api.reqManagedAccts();
        },
        undefined,
        [[EventName.managedAccounts, this.onManagedAccts]]
      )
      .pipe(
        take(1),
        map((v) => v.all)
      )
      .toPromise();
  }

  /** accountSummary event handler */
  private readonly onAccountSummary = (
    subscriptions: Map<number, IBApiNextSubscription<MutableAccountSummaries>>,
    reqId: number,
    account: string,
    tag: string,
    value: string,
    currency: string
  ): void => {
    // get the subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // update latest value on cache

    const cached = subscription.lastAllValue ?? new MutableAccountSummaries();

    const lastValue = cached
      .getOrAdd(account, () => new MutableAccountSummaryTagValues())
      .getOrAdd(tag, () => new MutableAccountSummaryValues());

    const hasChanged = lastValue.has(currency);

    const updatedValue: AccountSummaryValue = {
      value: value,
      ingressTm: Date.now(),
    };

    lastValue.set(currency, updatedValue);

    // sent change to subscribers

    const accountSummaryUpdate = new MutableAccountSummaries([
      [
        account,
        new MutableAccountSummaryTagValues([
          [tag, new MutableAccountSummaryValues([[currency, updatedValue]])],
        ]),
      ],
    ]);

    if (hasChanged) {
      subscription.next({
        all: cached,
        changed: accountSummaryUpdate,
      });
    } else {
      subscription.next({
        all: cached,
        added: accountSummaryUpdate,
      });
    }
  };

  /**
   * Create subscription to receive the account summaries of all linked accounts as presented in the TWS' Account Summary tab.
   *
   * All account summaries are sent on the first event.
   * Use incrementalUpdates argument to switch between incremental or full update mode.
   * With incremental updates, only changed account summary values will be sent after the initial complete list.
   * Without incremental updates, the complete list of account summaries will be sent again if any value has changed.
   *
   * https://www.interactivebrokers.com/en/software/tws/accountwindowtop.htm
   *
   * @param group Set to "All" to return account summary data for all accounts,
   * or set to a specific Advisor Account Group name that has already been created in TWS Global Configuration.
   * @param tags A comma separated list with the desired tags:
   * - AccountType — Identifies the IB account structure
   * - NetLiquidation — The basis for determining the price of the assets in your account. Total cash value + stock value + options value + bond value
   * - TotalCashValue — Total cash balance recognized at the time of trade + futures PNL
   * - SettledCash — Cash recognized at the time of settlement - purchases at the time of trade - commissions - taxes - fees
   * - AccruedCash — Total accrued cash value of stock, commodities and securities
   * - BuyingPower — Buying power serves as a measurement of the dollar value of securities that one may purchase in a securities account without depositing additional funds
   * - EquityWithLoanValue — Forms the basis for determining whether a client has the necessary assets to either initiate or maintain security positions. Cash + stocks + bonds + mutual funds
   * - PreviousEquityWithLoanValue — Marginable Equity with Loan value as of 16:00 ET the previous day
   * - GrossPositionValue — The sum of the absolute value of all stock and equity option positions
   * - RegTEquity — Regulation T equity for universal account
   * - RegTMargin — Regulation T margin for universal account
   * - SMA — Special Memorandum Account: Line of credit created when the market value of securities in a Regulation T account increase in value
   * - InitMarginReq — Initial Margin requirement of whole portfolio
   * - MaintMarginReq — Maintenance Margin requirement of whole portfolio
   * - AvailableFunds — This value tells what you have available for trading
   * - ExcessLiquidity — This value shows your margin cushion, before liquidation
   * - Cushion — Excess liquidity as a percentage of net liquidation value
   * - FullInitMarginReq — Initial Margin of whole portfolio with no discounts or intraday credits
   * - FullMaintMarginReq — Maintenance Margin of whole portfolio with no discounts or intraday credits
   * - FullAvailableFunds — Available funds of whole portfolio with no discounts or intraday credits
   * - FullExcessLiquidity — Excess liquidity of whole portfolio with no discounts or intraday credits
   * - LookAheadNextChange — Time when look-ahead values take effect
   * - LookAheadInitMarginReq — Initial Margin requirement of whole portfolio as of next period's margin change
   * - LookAheadMaintMarginReq — Maintenance Margin requirement of whole portfolio as of next period's margin change
   * - LookAheadAvailableFunds — This value reflects your available funds at the next margin change
   * - LookAheadExcessLiquidity — This value reflects your excess liquidity at the next margin change
   * - HighestSeverity — A measure of how close the account is to liquidation
   * - DayTradesRemaining — The Number of Open/Close trades a user could put on before Pattern Day Trading is detected. A value of "-1" means that the user can put on unlimited day trades.
   * - Leverage — GrossPositionValue / NetLiquidation
   * - $LEDGER — Single flag to relay all cash balance tags*, only in base currency.
   * - $LEDGER:CURRENCY — Single flag to relay all cash balance tags*, only in the specified currency.
   * - $LEDGER:ALL — Single flag to relay all cash balance tags* in all currencies.
   */
  getAccountSummary(
    group: string,
    tags: string
  ): Observable<AccountSummariesUpdate> {
    return this.subscriptions.register<MutableAccountSummaries>(
      (reqId) => {
        this.api.reqAccountSummary(reqId, group, tags);
      },
      (reqId) => {
        this.api.cancelAccountSummary(reqId);
      },
      [[EventName.accountSummary, this.onAccountSummary]],
      `${group}:${tags}`
    );
  }

  /** position event handler */
  private readonly onPosition = (
    subscriptions: Map<number, IBApiNextSubscription<MutableAccountPositions>>,
    account: string,
    contract: Contract,
    pos: number,
    avgCost: number
  ): void => {
    const updatedPosition: Position = { account, contract, pos, avgCost };

    // notify all subscribers

    subscriptions.forEach((subscription) => {
      // update latest value on cache

      let hasAdded = false;
      let hasRemoved = false;

      const cached = subscription.lastAllValue ?? new MutableAccountPositions();
      const accountPositions = cached.getOrAdd(account, () => []);
      const changePositionIndex = accountPositions.findIndex(
        (p) => p.contract.conId == contract.conId
      );

      if (changePositionIndex === -1) {
        // new position - add it
        accountPositions.push(updatedPosition);
        hasAdded = true;
      } else {
        if (!pos) {
          // zero size - remove it
          accountPositions.splice(changePositionIndex);
          hasRemoved = true;
        } else {
          // update
          accountPositions[changePositionIndex] = updatedPosition;
        }
      }

      if (hasAdded) {
        subscription.next({
          all: cached,
          added: new MutableAccountPositions([[account, [updatedPosition]]]),
        });
      } else if (hasRemoved) {
        subscription.next({
          all: cached,
          removed: new MutableAccountPositions([[account, [updatedPosition]]]),
        });
      } else {
        subscription.next({
          all: cached,
          changed: new MutableAccountPositions([[account, [updatedPosition]]]),
        });
      }
    });
  };

  /**
   * Create subscription to receive the positions on all accessible accounts.
   */
  getPositions(): Observable<AccountPositionsUpdate> {
    return this.subscriptions.register<MutableAccountPositions>(
      () => {
        this.api.reqPositions();
      },
      () => {
        this.api.cancelPositions();
      },
      [[EventName.position, this.onPosition]],
      "getPositions"
    );
  }

  /** contractDetails event handler */
  private readonly onContractDetails = (
    subscriptions: Map<number, IBApiNextSubscription<ContractDetails[]>>,
    reqId: number,
    details: ContractDetails
  ) => {
    // get the subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // update latest value on cache

    const cached = subscription.lastAllValue ?? [];
    cached.push(details);

    // sent change to subscribers

    subscription.next({
      all: cached,
      added: [details],
    });
  };

  /** contractDetailsEnd event handler */
  private readonly onContractDetailsEnd = (
    subscriptions: Map<number, IBApiNextSubscription<ContractDetails[]>>,
    reqId: number
  ) => {
    // get the subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // signal completion

    subscription.complete();
  };

  /**
   * Request contract information form TWS.
   * This method will provide all the contracts matching the contract provided.
   *
   * It can also be used to retrieve complete options and futures chains.
   * Though it is now (in API version > 9.72.12) advised to use reqSecDefOptParams for that purpose.
   *
   * This information will be emitted as contractDetails event.
   *
   * @param contract The contract used as sample to query the available contracts.
   */
  getContractDetails(contract: Contract): Observable<ContractDetailsUpdate> {
    return this.subscriptions.register<ContractDetails[]>(
      (reqId) => {
        this.api.reqContractDetails(reqId, contract);
      },
      undefined,
      [
        [EventName.contractDetails, this.onContractDetails],
        [EventName.contractDetailsEnd, this.onContractDetailsEnd],
      ]
    );
  }

  /** pnl event handler. */
  private onPnL = (
    subscriptions: Map<number, IBApiNextSubscription<PnL>>,
    reqId: number,
    dailyPnL: number,
    unrealizedPnL: number,
    realizedPnL: number
  ): void => {
    // get subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // sent change to subscribers

    subscription.next({
      all: { dailyPnL, unrealizedPnL, realizedPnL },
    });
  };

  /**
   * Create a subscription to receive real time daily PnL and unrealized PnL updates.
   *
   * @param account Account for which to receive PnL updates.
   * @param modelCode Specify to request PnL updates for a specific model.
   */
  getPnL(account: string, model?: string): Observable<PnL> {
    return this.subscriptions
      .register(
        (reqId) => {
          this.api.reqPnL(reqId, account, model);
        },
        (reqId) => {
          this.api.cancelPnL(reqId);
        },
        [[EventName.pnl, this.onPnL]],
        `${account}:${model}`
      )
      .pipe(map((v) => v.all));
  }

  /** pnlSingle event handler. */
  private readonly onPnLSingle = (
    subscriptions: Map<number, IBApiNextSubscription<PnLSingle>>,
    reqId: number,
    pos: number,
    dailyPnL: number,
    unrealizedPnL: number,
    realizedPnL: number,
    value: number
  ) => {
    // get subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // sent change to subscribers

    subscription.next({
      all: {
        position: pos,
        dailyPnL: undefineMax(dailyPnL),
        unrealizedPnL: undefineMax(unrealizedPnL),
        realizedPnL: undefineMax(realizedPnL),
        marketValue: undefineMax(value),
      },
    });
  };

  /**
   * Create a subscription to receive real time updates for daily PnL of individual positions.
   *
   * @param account Account in which position exists.
   * @param modelCode Model in which position exists.
   * @param conId Contract ID (conId) of contract to receive daily PnL updates for.
   */
  getPnLSingle(
    account: string,
    modelCode: string,
    conId: number
  ): Observable<PnLSingle> {
    return this.subscriptions
      .register<PnLSingle>(
        (reqId) => {
          this.api.reqPnLSingle(reqId, account, modelCode, conId);
        },
        (reqId) => {
          this.api.cancelPnLSingle(reqId);
        },
        [[EventName.pnlSingle, this.onPnLSingle]],
        `${account}:${modelCode}:${conId}`
      )
      .pipe(map((v) => v.all));
  }

  /**
   * Switches data type returned from reqMktData request to "frozen", "delayed" or "delayed-frozen" market data.
   * Requires TWS/IBG v963+.
   *
   * By default only real-time [[MarketDataType.REALTIME]] market data is enabled.
   *
   * The API can receive frozen market data from Trader Workstation.
   * Frozen market data is the last data recorded in our system.
   * During normal trading hours, the API receives real-time market data.
   * Invoking this function with argument [[MarketDataType.FROZEN]] requests a switch to frozen data immediately or after the close.
   * When the market reopens, the market data type will automatically switch back to real time if available.
   *
   * @param type The requested market data type.
   */
  setMarketDataType(type: MarketDataType): void {
    this.api.reqMarketDataType(type);
  }

  /** tickPrice, tickSize and tickGeneric event handler */
  private readonly onTick = (
    subscriptions: Map<number, IBApiNextSubscription<MutableMarketData>>,
    reqId: number,
    tickType: IBApiTickType,
    value: number
  ): void => {
    // filter -1 on Bid/Ask and Number.MAX_VALUE on all.

    if (
      value === -1 &&
      (tickType === IBApiTickType.BID ||
        tickType === IBApiTickType.DELAYED_BID ||
        tickType === IBApiTickType.ASK ||
        tickType === IBApiTickType.DELAYED_ASK)
    ) {
      value = Number.MAX_VALUE;
    }
    if (value === Number.MAX_VALUE) {
      return;
    }

    // get subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // update latest value on cache

    const cached = subscription.lastAllValue ?? new MutableMarketData();
    const hasChanged = cached.has(tickType);

    const updatedValue: MarketDataTick = {
      value,
      ingressTm: Date.now(),
    };

    cached.set(tickType, updatedValue);

    // deliver to subject

    if (hasChanged) {
      subscription.next({
        all: cached,
        changed: new MutableMarketData([[tickType, updatedValue]]),
      });
    } else {
      subscription.next({
        all: cached,
        added: new MutableMarketData([[tickType, updatedValue]]),
      });
    }
  };

  /** tickOptionComputationHandler event handler */
  private readonly onTickOptionComputation = (
    subscriptions: Map<number, IBApiNextSubscription<MutableMarketData>>,
    reqId: number,
    field: number,
    impliedVolatility: number,
    delta: number,
    optPrice: number,
    pvDividend: number,
    gamma: number,
    vega: number,
    theta: number,
    undPrice: number
  ): void => {
    // get subscription

    const subscription = subscriptions.get(reqId);
    if (!subscription) {
      return;
    }

    // generate [[IBApiNext]] market data ticks

    const now = Date.now();

    const ticks: [IBApiNextTickType, MarketDataTick][] = [
      [
        IBApiNextTickType.OPTION_UNDERLYING,
        { value: undPrice, ingressTm: now },
      ],
      [
        IBApiNextTickType.OPTION_PV_DIVIDEND,
        { value: pvDividend, ingressTm: now },
      ],
    ];

    switch (field) {
      case IBApiTickType.BID_OPTION:
        ticks.push(
          [
            IBApiNextTickType.BID_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.BID_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.BID_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.BID_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [IBApiNextTickType.BID_OPTION_VEGA, { value: vega, ingressTm: now }],
          [IBApiNextTickType.BID_OPTION_THETA, { value: theta, ingressTm: now }]
        );
        break;
      case IBApiTickType.DELAYED_BID_OPTION:
        ticks.push(
          [
            IBApiNextTickType.DELAYED_BID_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_BID_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_BID_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_BID_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_BID_OPTION_VEGA,
            { value: vega, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_BID_OPTION_THETA,
            { value: theta, ingressTm: now },
          ]
        );
        break;
      case IBApiTickType.ASK_OPTION:
        ticks.push(
          [
            IBApiNextTickType.ASK_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.ASK_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.ASK_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.ASK_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [IBApiNextTickType.ASK_OPTION_VEGA, { value: vega, ingressTm: now }],
          [IBApiNextTickType.ASK_OPTION_THETA, { value: theta, ingressTm: now }]
        );
        break;
      case IBApiTickType.DELAYED_ASK_OPTION:
        ticks.push(
          [
            IBApiNextTickType.DELAYED_ASK_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_ASK_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_ASK_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_ASK_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_ASK_OPTION_VEGA,
            { value: vega, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_ASK_OPTION_THETA,
            { value: theta, ingressTm: now },
          ]
        );
        break;
      case IBApiTickType.LAST_OPTION:
        ticks.push(
          [
            IBApiNextTickType.LAST_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.LAST_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.LAST_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.LAST_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [IBApiNextTickType.LAST_OPTION_VEGA, { value: vega, ingressTm: now }],
          [
            IBApiNextTickType.LAST_OPTION_THETA,
            { value: theta, ingressTm: now },
          ]
        );
        break;
      case IBApiTickType.DELAYED_LAST_OPTION:
        ticks.push(
          [
            IBApiNextTickType.DELAYED_LAST_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_LAST_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_LAST_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_LAST_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_LAST_OPTION_VEGA,
            { value: vega, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_LAST_OPTION_THETA,
            { value: theta, ingressTm: now },
          ]
        );
        break;
      case IBApiTickType.MODEL_OPTION:
        ticks.push(
          [
            IBApiNextTickType.MODEL_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.MODEL_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.MODEL_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.MODEL_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [
            IBApiNextTickType.MODEL_OPTION_VEGA,
            { value: vega, ingressTm: now },
          ],
          [
            IBApiNextTickType.MODEL_OPTION_THETA,
            { value: theta, ingressTm: now },
          ]
        );
        break;
      case IBApiTickType.DELAYED_MODEL_OPTION:
        ticks.push(
          [
            IBApiNextTickType.DELAYED_MODEL_OPTION_IV,
            { value: impliedVolatility, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_MODEL_OPTION_DELTA,
            { value: delta, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_MODEL_OPTION_PRICE,
            { value: optPrice, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_MODEL_OPTION_GAMMA,
            { value: gamma, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_MODEL_OPTION_VEGA,
            { value: vega, ingressTm: now },
          ],
          [
            IBApiNextTickType.DELAYED_MODEL_OPTION_THETA,
            { value: theta, ingressTm: now },
          ]
        );
        break;
    }

    // update latest value on cache

    const cached = subscription.lastAllValue ?? new MutableMarketData();
    const added = new MutableMarketData();
    const changed = new MutableMarketData();

    ticks.forEach((tick) => {
      if (tick[1].value !== Number.MAX_VALUE && tick[1].value !== undefined) {
        if (cached.has(tick[0])) {
          changed.set(tick[0], tick[1]);
        } else {
          added.set(tick[0], tick[1]);
        }
        cached.set(tick[0], tick[1]);
      }
    });

    // deliver to subject

    if (cached.size) {
      subscription.next({
        all: cached,
        added: added.size ? added : undefined,
        changed: changed.size ? changed : undefined,
      });
    }
  };

  /**
   * Create a subscription to receive real time market data.
   * Returns market data for an instrument either in real time or 10-15 minutes delayed (depending on the market data type specified,
   * see [[setMarketDataType]]).
   *
   * @param contract The [[Contract]] for which the data is being requested
   * @param genericTickList comma  separated ids of the available generic ticks:
   * - 100 Option Volume (currently for stocks)
   * - 101 Option Open Interest (currently for stocks)
   * - 104 Historical Volatility (currently for stocks)
   * - 105 Average Option Volume (currently for stocks)
   * - 106 Option Implied Volatility (currently for stocks)
   * - 162 Index Future Premium
   * - 165 Miscellaneous Stats
   * - 221 Mark Price (used in TWS P&L computations)
   * - 225 Auction values (volume, price and imbalance)
   * - 233 RTVolume - contains the last trade price, last trade size, last trade time, total volume, VWAP, and single trade flag.
   * - 236 Shortable
   * - 256 Inventory
   * - 258 Fundamental Ratios
   * - 411 Realtime Historical Volatility
   * - 456 IBDividends
   * @param snapshot For users with corresponding real time market data subscriptions.
   * A `true` value will return a one-time snapshot, while a `false` value will provide streaming data.
   * @param regulatorySnapshot Snapshot for US stocks requests NBBO snapshots for users which have "US Securities Snapshot Bundle" subscription
   * but not corresponding Network A, B, or C subscription necessary for streaming * market data.
   * One-time snapshot of current market price that will incur a fee of 1 cent to the account per snapshot.
   */
  getMarketData(
    contract: Contract,
    genericTickList: string,
    snapshot: boolean,
    regulatorySnapshot: boolean
  ): Observable<MarketDataUpdate> {
    return this.subscriptions.register<MutableMarketData>(
      (reqId) => {
        this.api.reqMktData(
          reqId,
          contract,
          genericTickList,
          snapshot,
          regulatorySnapshot
        );
      },
      (reqId) => {
        // when using snapshot, cancel will cause a "Can't find EId with tickerId" error.
        if (!snapshot && !regulatorySnapshot) {
          this.api.cancelMktData(reqId);
        }
      },
      [
        [EventName.tickPrice, this.onTick],
        [EventName.tickSize, this.onTick],
        [EventName.tickGeneric, this.onTick],
        [EventName.tickOptionComputation, this.onTickOptionComputation],
      ],
      snapshot || regulatorySnapshot
        ? undefined
        : `${JSON.stringify(contract)}:${genericTickList}`
    );
  }
}
