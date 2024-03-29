import { Broker, BrokerName } from 'inves-broker'
import { KiteOrder } from '../../types/kite'
import {
  ATM_STRADDLE_TRADE,
  ATM_STRANGLE_TRADE,
  SUPPORTED_TRADE_CONFIG
} from '../../types/trade'
import {
  ORDER_STATUS,
  ORDER_TYPE,
  TRANSACTION_TYPE,
  USER_OVERRIDE
} from '../constants'
import getInvesBrokerInstance from '../invesBroker'
import console from '../logging'
import {
  // logDeep,
  patchDbTrade,
  remoteOrderSuccessEnsurer,
  syncGetKiteInstance,
  withRemoteRetry
} from '../utils'

export async function doDeletePendingOrders (
  orders: KiteOrder[],
  broker: Broker,
  initialJobData: Partial<SUPPORTED_TRADE_CONFIG>
) {
  const { user } = initialJobData
  const allOrders: KiteOrder[] = await withRemoteRetry(() =>
    broker.getOrders({
      kiteAccessToken: user?.session.accessToken
    })
  )
  const openOrders: KiteOrder[] = allOrders.filter(
    order => order.status === 'TRIGGER PENDING'
  )

  const openOrdersForPositions = orders
    .map(order =>
      openOrders.find(
        openOrder =>
          openOrder.product === order.product &&
          openOrder.exchange === order.exchange &&
          openOrder.tradingsymbol === order.tradingsymbol &&
          // reverse trade on same exchange + tradingsybol is not possible,
          // so doing `abs`
          Math.abs(openOrder.quantity) === Math.abs(order.quantity)
      )
    )
    .filter(o => o)

  // some positions might have squared off during the day when the SL hit
  return Promise.all(
    openOrdersForPositions.map(async (openOrder: KiteOrder) =>
      withRemoteRetry(() =>
        broker.cancelOrder(
          {
            orderId: openOrder.order_id as string,
            variety: openOrder.variety,
            orderType: openOrder.order_type,
            product: openOrder.product,
            exchange: openOrder.exchange,
            exchangeToken: 0,
            quantity: openOrder.quantity,
            tradingSymbol: openOrder.tradingsymbol,
            transactionType: openOrder.transaction_type,
            validity: openOrder.validity as string
          },
          user?.session.accessToken as string
        )
      )
    )
  )
}

export async function doSquareOffPositions (
  orders: KiteOrder[],
  broker: Broker,
  initialJobData: Partial<SUPPORTED_TRADE_CONFIG>
) {
  const { user } = initialJobData
  const openPositions = await withRemoteRetry(() =>
    broker.getPositions({
      kiteAccessToken: user?.session.accessToken
    })
  )
  const { net } = openPositions
  const openPositionsForOrders = orders
    .filter(o => o)
    .map(order => {
      const position = net.find(
        openPosition =>
          openPosition.tradingsymbol === order.tradingsymbol &&
          openPosition.exchange === order.exchange &&
          openPosition.product === order.product &&
          (openPosition.quantity < 0
            ? // openPosition is short order
              openPosition.quantity <= order.quantity * -1
            : // long order
              openPosition.quantity >= order.quantity)
      )

      if (!position) {
        return null
      }

      return {
        ...position,
        quantity: position.quantity < 0 ? order.quantity * -1 : order.quantity
      }
    })
    .filter(o => o)

  const remoteRes = await Promise.all(
    openPositionsForOrders.map(async order => {
      const exitOrder = {
        tradingsymbol: order.tradingsymbol,
        quantity: Math.abs(order.quantity),
        exchange: order.exchange,
        transaction_type:
          order.quantity < 0 ? TRANSACTION_TYPE.BUY : TRANSACTION_TYPE.SELL,
        order_type: ORDER_TYPE.MARKET,
        product: order.product,
        tag: initialJobData.orderTag
      }
      // console.log('square off position...', exitOrder)
      return remoteOrderSuccessEnsurer({
        _kite: broker as any,
        orderProps: exitOrder,
        instrument: initialJobData.instrument!,
        ensureOrderState: ORDER_STATUS.COMPLETE,
        user: initialJobData.user!
      })
    })
  )

  if (
    (initialJobData as ATM_STRANGLE_TRADE | ATM_STRADDLE_TRADE)
      .onSquareOffSetAborted
  ) {
    try {
      await patchDbTrade({
        _id: initialJobData._id!,
        patchProps: {
          user_override: USER_OVERRIDE.ABORT
        }
      })
    } catch (error) {
      console.log('error in onSquareOffSetAborted', error)
    }
  }

  return remoteRes
}

async function autoSquareOffStrat ({
  rawKiteOrdersResponse,
  deletePendingOrders,
  initialJobData
}: {
  rawKiteOrdersResponse: KiteOrder[]
  deletePendingOrders: boolean
  initialJobData: SUPPORTED_TRADE_CONFIG
}): Promise<any> {
  const { user } = initialJobData
  const invesBrokerInstance = await getInvesBrokerInstance(BrokerName.KITE)
  const completedOrders = rawKiteOrdersResponse

  if (deletePendingOrders) {
    // console.log('deletePendingOrders init')
    try {
      await doDeletePendingOrders(
        completedOrders,
        invesBrokerInstance,
        initialJobData
      )
      // console.log('🟢 deletePendingOrders success', res)
    } catch (e) {
      console.log('🔴 deletePendingOrders failed')
      console.error(e)
    }
  }
  return doSquareOffPositions(
    completedOrders,
    invesBrokerInstance,
    initialJobData
  )
}

export default autoSquareOffStrat
