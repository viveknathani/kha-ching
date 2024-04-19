import dayjs, { ConfigType } from 'dayjs'
import { SignalXUser } from '../../types/misc'
import { ATM_STRADDLE_TRADE } from '../../types/trade'

import {
  EXCHANGE,
  EXPIRY_TYPE,
  INSTRUMENT_DETAILS,
  INSTRUMENT_PROPERTIES,
  ORDER_STATUS,
  ORDER_TYPE,
  PRODUCT_TYPE,
  TRANSACTION_TYPE,
  VALIDITY,
  VOLATILITY_TYPE
} from '../constants'
import { doSquareOffPositions } from '../exit-strategies/autoSquareOff'
import console from '../logging'
import { EXIT_TRADING_Q_NAME } from '../queue'
import {
  attemptBrokerOrders,
  delay,
  ensureMarginForBasketOrder,
  getExpiryTradingSymbol,
  getHedgeForStrike,
  getIndexInstruments,
  getInstrumentPrice,
  getSkew,
  ms,
  remoteOrderSuccessEnsurer,
  StrikeInterface,
  syncGetKiteInstance,
  withRemoteRetry
} from '../utils'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'
import { getInvesBrokerInstance } from '../invesBroker'
import { Broker, BrokerName, OrderInformation } from 'inves-broker'

dayjs.extend(isSameOrBefore)

interface GET_ATM_STRADDLE_ARGS
  extends ATM_STRADDLE_TRADE,
    INSTRUMENT_PROPERTIES {
  startTime: ConfigType
  attempt?: number
  instrumentsData: Record<string, unknown>[]
}

export async function getATMStraddle (
  args: Partial<GET_ATM_STRADDLE_ARGS>
): Promise<{
  PE_STRING: string
  CE_STRING: string
  atmStrike: number
}> {
  const {
    _kite,
    startTime,
    user,
    underlyingSymbol,
    exchange,
    nfoSymbol,
    strikeStepSize,
    maxSkewPercent,
    thresholdSkewPercent,
    takeTradeIrrespectiveSkew,
    expiresAt,
    expiryType,
    attempt = 0
  } = args
  try {
    /**
     * getting a little smarter about skews
     *
     * if 50% time has elapsed, then start increasing skew % by weighing heavier towards thresholdSkewPercent
     * every passing equal split duration
     *
     * so for example - if skew checker is going to run for 10mins
     * and 5 mins have passed, divide the remaining time between equidistant buckets
     * so each fractional time remaining, keep gravitating towards thresholdSkewPercent
     * e.g. between 5-6min, skew = 50% * (maxSkewPercent) + 50% * (thresholdSkewPercent)
     * between 6-7min, skew = 40% * (maxSkewPercent) + 60% * (thresholdSkewPercent)
     * ...and so on and so forth
     *
     * and then eventually if the timer expires, then decide basis `takeTradeIrrespectiveSkew`
     */

    const kite = _kite || (await getInvesBrokerInstance(BrokerName.KITE))
    const totalTime = dayjs(expiresAt).diff(startTime!)
    const remainingTime = dayjs(expiresAt).diff(dayjs())
    const timeExpired = dayjs().isAfter(dayjs(expiresAt))

    const fractionalTimeRemaining = remainingTime / totalTime
    const updatedSkewPercent = thresholdSkewPercent
      ? fractionalTimeRemaining >= 0.5
        ? maxSkewPercent
        : Math.round(
            fractionalTimeRemaining * maxSkewPercent! +
              (1 - fractionalTimeRemaining) * thresholdSkewPercent
          )
      : maxSkewPercent

    const underlyingLTP = await withRemoteRetry(async () =>
      getInstrumentPrice(
        kite as Broker,
        underlyingSymbol!,
        exchange!,
        user?.session.accessToken
      )
    )
    const atmStrike =
      Math.round(underlyingLTP / strikeStepSize!) * strikeStepSize!

    const { PE_STRING, CE_STRING } = (await getExpiryTradingSymbol({
      nfoSymbol,
      strike: atmStrike,
      expiry: expiryType
    })) as StrikeInterface
    console.log(`Expiry ${expiryType} strikes: ${PE_STRING} & ${CE_STRING}`)
    // if time has expired
    if (timeExpired) {
      console.log(
        `🔔 [atmStraddle] time has run out! takeTradeIrrespectiveSkew = ${takeTradeIrrespectiveSkew!.toString()}`
      )
      if (takeTradeIrrespectiveSkew) {
        return {
          PE_STRING,
          CE_STRING,
          atmStrike
        }
      }

      return Promise.reject(
        new Error(
          '[atmStraddle] time expired and takeTradeIrrespectiveSkew is false'
        )
      )
    }

    // if time hasn't expired
    const { skew } = await withRemoteRetry(async () =>
      getSkew(kite, PE_STRING, CE_STRING, 'NFO', user?.session.accessToken)
    )
    // if skew not fitting in, try again
    if (skew > updatedSkewPercent!) {
      console.log(
        `Retry #${attempt +
          1}... Live skew (${skew as string}%) > Skew consideration (${String(
          updatedSkewPercent
        )}%)`
      )
      await delay(ms(2))
      return getATMStraddle({ ...args, attempt: attempt + 1 })
    }

    console.log(
      `[atmStraddle] punching with current skew ${String(
        skew
      )}%, and last skew threshold was ${String(updatedSkewPercent)}`
    )

    // if skew is fitting in, return
    return {
      PE_STRING,
      CE_STRING,
      atmStrike
    }
  } catch (e) {
    console.log('[getATMStraddle] exception', e)
    if (e?.error_type === 'NetworkException') {
      return getATMStraddle({ ...args, attempt: attempt + 1 })
    }
    return Promise.reject(e)
  }
}

export const createOrder = ({
  symbol,
  lots,
  lotSize,
  user,
  orderTag,
  transactionType,
  productType
}: {
  symbol: string
  lots: number
  lotSize: number
  user: SignalXUser
  orderTag: string
  transactionType?: string
  productType: PRODUCT_TYPE
}) => {
  return {
    tradingSymbol: symbol,
    quantity: lotSize * lots,
    exchange: EXCHANGE.NFO,
    transactionType: (transactionType ?? TRANSACTION_TYPE.SELL) as any,
    orderType: ORDER_TYPE.MARKET,
    product: productType,
    validity: VALIDITY.DAY,
    tag: orderTag
  }
}

async function atmStraddle ({
  _kite,
  instrument,
  lots,
  user,
  expiresAt,
  orderTag,
  rollback,
  maxSkewPercent,
  thresholdSkewPercent,
  takeTradeIrrespectiveSkew,
  isHedgeEnabled,
  hedgeDistance,
  productType = PRODUCT_TYPE.MIS,
  volatilityType = VOLATILITY_TYPE.SHORT,
  expiryType = EXPIRY_TYPE.CURRENT,
  _nextTradingQueue = EXIT_TRADING_Q_NAME
}: ATM_STRADDLE_TRADE): Promise<
  | {
      _nextTradingQueue: string
      straddle: Record<string, unknown>
      rawKiteOrdersResponse: OrderInformation[]
      squareOffOrders: OrderInformation[]
    }
  | undefined
> {
  const kite = _kite || (await getInvesBrokerInstance(BrokerName.KITE))

  const {
    underlyingSymbol,
    exchange,
    nfoSymbol,
    lotSize,
    strikeStepSize
  } = INSTRUMENT_DETAILS[instrument]

  const instrumentsData = await getIndexInstruments()

  try {
    const straddle = await getATMStraddle({
      _kite,
      startTime: dayjs(),
      user,
      instrumentsData,
      underlyingSymbol,
      exchange,
      nfoSymbol,
      strikeStepSize,
      maxSkewPercent,
      thresholdSkewPercent,
      takeTradeIrrespectiveSkew,
      expiresAt,
      expiryType
    })

    const { PE_STRING, CE_STRING, atmStrike } = straddle

    let allOrdersLocal: any[] = []
    let hedgeOrdersLocal: any[] = []
    let allOrders: OrderInformation[] = []

    if (volatilityType === VOLATILITY_TYPE.SHORT && isHedgeEnabled) {
      const [putHedge, callHedge] = await Promise.all(
        ['PE', 'CE'].map(async type =>
          getHedgeForStrike({
            strike: atmStrike,
            distance: hedgeDistance!,
            type,
            nfoSymbol,
            expiryType
          })
        )
      )
      hedgeOrdersLocal = [putHedge, callHedge].map(symbol =>
        createOrder({
          symbol,
          lots,
          lotSize,
          user: user!,
          orderTag: orderTag!,
          transactionType: TRANSACTION_TYPE.SELL,
          productType
        })
      )
      allOrdersLocal = [...hedgeOrdersLocal]
    }

    const orders = [PE_STRING, CE_STRING].map(symbol =>
      createOrder({
        symbol,
        lots,
        lotSize,
        user: user!,
        orderTag: orderTag!,
        productType,
        transactionType:
          volatilityType === VOLATILITY_TYPE.SHORT
            ? TRANSACTION_TYPE.SELL
            : TRANSACTION_TYPE.BUY
      })
    )

    allOrdersLocal = [...allOrdersLocal, ...orders]

    const hasMargin = await withRemoteRetry(async () =>
      ensureMarginForBasketOrder(user, allOrdersLocal)
    )
    if (!hasMargin) {
      throw Error('insufficient margin!')
    }

    if (hedgeOrdersLocal.length) {
      const hedgeOrdersPr = hedgeOrdersLocal.map(async order =>
        remoteOrderSuccessEnsurer({
          _kite: kite as any,
          orderProps: order,
          instrument,
          ensureOrderState: ORDER_STATUS.COMPLETE,
          user: user!
        })
      )

      const { allOk, statefulOrders } = await attemptBrokerOrders(hedgeOrdersPr)
      if (!allOk && rollback?.onBrokenHedgeOrders) {
        await doSquareOffPositions(statefulOrders, kite as any, {
          orderTag
        })

        throw Error('rolled back onBrokenHedgeOrders')
      }

      allOrders = [...statefulOrders]
    }

    const brokerOrdersPr = orders.map(async order =>
      remoteOrderSuccessEnsurer({
        _kite: kite as any,
        orderProps: order,
        instrument,
        ensureOrderState: ORDER_STATUS.COMPLETE,
        user: user!
      })
    )

    const { allOk, statefulOrders } = await attemptBrokerOrders(brokerOrdersPr)
    allOrders = [...allOrders, ...statefulOrders]
    if (!allOk && rollback?.onBrokenPrimaryOrders) {
      await doSquareOffPositions(allOrders, kite as any, {
        orderTag
      })

      throw Error('rolled back on onBrokenPrimaryOrders')
    }

    return {
      _nextTradingQueue,
      straddle,
      rawKiteOrdersResponse: statefulOrders,
      squareOffOrders: allOrders
    }
  } catch (e) {
    console.log(e)
    throw e
  }
}

export default atmStraddle
