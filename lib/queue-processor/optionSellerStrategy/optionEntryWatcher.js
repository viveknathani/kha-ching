import {
  EXCHANGE,
  INSTRUMENT_DETAILS,
  ORDER_STATUS,
  ORDER_TYPE,
  PRODUCT_TYPE,
  TRANSACTION_TYPE,
  VALIDITY
} from '../../constants'
import {
  getIndexInstruments,
  getInstrumentPrice,
  getTradingSymbolsByOptionPrice,
  syncGetKiteInstance
} from '../../utils'

import console from '../../logging'
import getInvesBrokerInstance from '../../invesBroker'
import { BrokerName } from 'inves-broker'
// import { addToNextQueue, WATCHER_Q_NAME } from '../queue'

const optionSellerEntryWatcher = async ({
  limitOrderAckId,
  entryPrice,
  slTriggerPrice,
  watchForOrderState,
  initialJobData,
  addHedge
}) => {
  try {
    const { user, orderTag, instrument, expiryType } = initialJobData
    const kite = await getInvesBrokerInstance(BrokerName.KITE)
    const orderHistory = await kite.getOrderHistory({
      orderId: limitOrderAckId,
      kiteAccessToken: user?.session.accessToken
    })
    const revOrderHistory = orderHistory.reverse()
    const completedOrder = revOrderHistory.find(
      order => order.status === ORDER_STATUS.COMPLETE
    )
    if (!completedOrder) {
      return Promise.reject(
        new Error('[optionSellerEntryWatcher] still pending!')
      )
    }

    const slOrder = {
      tradingsymbol: completedOrder.tradingsymbol,
      quantity: completedOrder.quantity,
      exchange: EXCHANGE.NFO,
      transaction_type: TRANSACTION_TYPE.BUY,
      trigger_price: slTriggerPrice,
      order_type: ORDER_TYPE.SL_M,
      product: PRODUCT_TYPE.MIS,
      validity: VALIDITY.DAY,
      tag: orderTag
    }

    console.log({ slOrder })
    // order completed! punch the SL and hedge order
    const { order_id: slOrderAckId } = await kite.placeOrder(
      kite.VARIETY_REGULAR,
      slOrder
    )

    console.log({ slOrderAckId })

    const { nfoSymbol, underlyingSymbol, strikeStepSize } = INSTRUMENT_DETAILS[
      instrument
    ]
    const instrumentsData = await getIndexInstruments()

    const underlyingLTP = await getInstrumentPrice(
      kite,
      underlyingSymbol,
      kite.EXCHANGE_NFO
    )
    const atmStrike =
      Math.round(underlyingLTP / strikeStepSize) * strikeStepSize
    console.log({ atmStrike })

    if (!addHedge) {
      return { slOrderAckId }
    }

    const {
      tradingsymbol: hedgeTradingSymbol
    } = await getTradingSymbolsByOptionPrice({
      sourceData: instrumentsData,
      nfoSymbol,
      price: 1,
      pivotStrike: atmStrike,
      instrumentType: completedOrder.tradingSymbol.substr(
        completedOrder.tradingSymbol.length - 2,
        completedOrder.tradingSymbol.length - 1
      ),
      user,
      expiry: expiryType
    })

    const hedgeOrder = {
      tradingSymbol: hedgeTradingSymbol,
      quantity: completedOrder.quantity,
      exchange: EXCHANGE.NFO,
      transactionType: TRANSACTION_TYPE.BUY,
      triggerPrice: slTriggerPrice,
      orderType: ORDER_TYPE.MARKET,
      product: PRODUCT_TYPE.MIS,
      validity: VALIDITY.DAY,
      tag: orderTag
    }

    const { order_id: hedgeOrderAckId } = await kite.placeOrder(
      hedgeOrder,
      user?.session.accessToken
    )
    return { slOrderAckId, hedgeOrderAckId }
  } catch (e) {
    console.log('🔴 [optionSellerEntryWatcher] error. Checker terminated!!', e)
    // a promise reject here could be dangerous due to retry logic.
    // It could lead to multiple exit orders for the same initial order_id
    // hence, resolve
    return Promise.resolve('[optionSellerEntryWatcher] error')
  }
}

export default optionSellerEntryWatcher
