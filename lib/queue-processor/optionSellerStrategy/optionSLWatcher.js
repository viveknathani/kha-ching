import { syncGetKiteInstance } from '../../utils'

import console from '../../logging'
import { getInvesBrokerInstance } from '../../invesBroker'
import { BrokerName } from 'inves-broker'
import {
  EXCHANGE,
  ORDER_STATUS,
  ORDER_TYPE,
  PRODUCT_TYPE,
  TRANSACTION_TYPE,
  VALIDITY
} from '../../constants'

const optionSellerSLWatcher = async ({
  slOrderAckId,
  entryPrice,
  slTriggerPrice,
  watchForOrderState,
  initialJobData,
  attemptCount,
  maxAttempts
}) => {
  try {
    const { user, orderTag } = initialJobData
    const kite = await getInvesBrokerInstance(BrokerName.KITE)
    const orderHistory = await kite.getOrderHistory({
      orderId: slOrderAckId,
      kiteAccessToken: user?.session.accessToken
    })
    const revOrderHistory = orderHistory.reverse()
    const completedOrder = revOrderHistory.find(
      order => order.status === ORDER_STATUS.COMPLETE
    )
    if (!completedOrder) {
      return Promise.reject(new Error('[optionSellerSLWatcher] still pending!'))
    }

    if (attemptCount > maxAttempts) {
      return Promise.resolve('all re-attempts exhausted')
    }

    const reEntryOrder = {
      tradingSymbol: completedOrder.tradingsymbol,
      quantity: completedOrder.quantity,
      exchange: EXCHANGE.NFO,
      transactionType: TRANSACTION_TYPE.SELL,
      triggerPrice: entryPrice,
      orderType: ORDER_TYPE.SL_M,
      product: PRODUCT_TYPE.MIS,
      validity: VALIDITY.DAY,
      tag: orderTag
    }

    // order completed! punch the SL
    const { order_id: reEntryOrderAckId } = await kite.placeOrder(
      reEntryOrder,
      user?.session.accessToken
    )

    console.log({ reEntryOrderAckId })
  } catch (e) {
    console.log('🔴 [optionSellerSLWatcher] error. Checker terminated!!', e)
    // a promise reject here could be dangerous due to retry logic.
    // It could lead to multiple exit orders for the same initial order_id
    // hence, resolve
    return Promise.resolve('[optionSellerSLWatcher] error')
  }
}

export default optionSellerSLWatcher
