import { BrokerName } from 'inves-broker'
import {
  EXCHANGE,
  INSTRUMENT_DETAILS,
  ORDER_TYPE,
  PRODUCT_TYPE,
  TRANSACTION_TYPE,
  VALIDITY
} from '../../constants'
import { getInvesBrokerInstance } from '../../invesBroker'
import console from '../../logging'
import orderResponse from '../../strategies/mockData/orderResponse'
import { fetchHistoricalPrice } from '../../strategies/optionSellerStrategy'
import {
  getAllOrNoneCompletedOrdersByKiteResponse,
  getPercentageChange,
  syncGetKiteInstance
} from '../../utils'

async function optionSellerOptionEntry ({ initialJobData, optionStrike }) {
  const [priceData] = await fetchHistoricalPrice(optionStrike.instrument_token)
  const { low, high } = priceData
  const entryLimitPrice = low - 0.5
  const slTriggerPrice = high + 0.5
  const rr = entryLimitPrice / (slTriggerPrice - entryLimitPrice)
  const candleSkew = getPercentageChange(low, high, 'CONSERVATIVE')
  const isTallCandle = candleSkew > 50

  const favourableEntry = rr > 1 && !isTallCandle

  if (!favourableEntry) {
    return null
    // return Promise.reject(new Error('🔴 [optionSellerOptionEntry] not favourableEntry. Will retry!'))
  }

  const { user, lots, orderTag, instrument } = initialJobData
  const { lotSize } = INSTRUMENT_DETAILS[instrument]
  const kite = await getInvesBrokerInstance(BrokerName.KITE)

  const order = {
    tradingSymbol: optionStrike.tradingsymbol,
    quantity: Number(lots) * lotSize,
    exchange: EXCHANGE.NFO,
    transactionType: TRANSACTION_TYPE.SELL,
    triggerPrice: entryLimitPrice,
    orderType: ORDER_TYPE.SL_M,
    product: PRODUCT_TYPE.MIS,
    validity: VALIDITY.DAY,
    tag: orderTag
  }

  // placing a SLM order, not market order
  const { order_id: limitOrderAckId } = await kite.placeOrder(
    order,
    user?.session.accessToken
  )

  return {
    entryLimitPrice,
    slTriggerPrice,
    limitOrderAckId
  }

  // return {
  //   rr,
  //   candleSkew,
  //   isTallCandle,
  //   favourableEntry
  // }

  // if (MOCK_ORDERS) {
  //   const mockResponse = [...new Array(rawKiteOrdersResponse.length)].map(
  //     (_, idx) => orderResponse[idx]
  //   )
  //   return mockResponse
  // }

  // const { slmPercent, user } = initialJobData
  // const kite = syncGetKiteInstance(user)
  // const completedOrders = await getAllOrNoneCompletedOrdersByKiteResponse(
  //   kite,
  //   rawKiteOrdersResponse
  // )

  // if (!completedOrders) {
  //   console.error('Initial order not completed yet! Waiting for `Completed` order type...')
  //   throw new Error('Initial order not completed yet! Waiting for `Completed` order type...')
  // }

  // console.log('🟢 Initial order punched on Zerodha!')

  // const SLM_PERCENTAGE = 1 + slmPercent / 100
  // const exitOrders = completedOrders.map((order) => {
  //   const exitPrice = Math.round(order.average_price * SLM_PERCENTAGE)
  //   const exitOrder = {
  //     trigger_price: exitPrice,
  //     tradingsymbol: order.tradingsymbol,
  //     quantity: Math.abs(quantityMultiplier * order.quantity),
  //     exchange: order.exchange,
  //     transaction_type: type === 'BUY' ? kite.TRANSACTION_TYPE_BUY : kite.TRANSACTION_TYPE_SELL,
  //     order_type: kite.ORDER_TYPE_SLM,
  //     product: order.product,
  //     tag: initialJobData.orderTag
  //   }
  //   console.log('placing exit orders...', exitOrder)
  //   return kite.placeOrder(kite.VARIETY_REGULAR, exitOrder)
  // })

  // try {
  //   const response = await Promise.all(exitOrders)
  //   console.log(response)
  //   return response
  // } catch (e) {
  //   console.log('exit orders failed!!', e)
  //   throw new Error(e)
  // }
}

export default optionSellerOptionEntry
