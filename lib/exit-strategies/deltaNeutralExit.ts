import dayjs from 'dayjs'
import { Await } from '../../types'
import { KiteOrder } from '../../types/kite'
import { COMBINED_SL_EXIT_STRATEGY } from '../../types/plans'
import { ATM_STRADDLE_TRADE, ATM_STRANGLE_TRADE, DELTA_NEUTRAL_TRADE } from '../../types/trade'
import { EXIT_STRATEGIES, USER_OVERRIDE } from '../constants'
import console from '../logging'
import { addToNextQueue, EXIT_TRADING_Q_NAME } from '../queue'
import {
  getTimeLeftInMarketClosingMs,
  syncGetKiteInstance,
  withRemoteRetry,
  patchDbTrade,
  delay,
  ms,
  getSortedMatchingIntrumentsData,
  getOptionChain
} from '../utils'

import { doSquareOffPositions } from './autoSquareOff'

const patchTradeWithDeltaDiff = async ({ dbId, deltaDiff }) =>
  await patchDbTrade({
    _id: dbId,
    patchProps: {
      liveDeltaDiff: deltaDiff,
      lastDetaDiffSetAt: dayjs().format()
    }
  })

const tradeHeartbeat = async dbId => {
  const data = await patchDbTrade({
    _id: dbId,
    patchProps: {
      lastHeartbeatAt: dayjs().format()
    }
  })

  return data
}

async function deltaNeutralExitStrat ({
  initialJobData,
  rawKiteOrdersResponse,
  squareOffOrders
}: {
  initialJobData: DELTA_NEUTRAL_TRADE
  rawKiteOrdersResponse: KiteOrder[]
  squareOffOrders?: KiteOrder[]
}): Promise<any> {
  try {
    if (getTimeLeftInMarketClosingMs() < 0) {
      return Promise.resolve(
        '🟢 [deltaNeutralExitStrat] Terminating Delta Neutral checker as market closing...'
      )
    }

    const {
      user,
      deltaStrikes,
      instrument,
      _id: dbId
    } = initialJobData
    const kite = syncGetKiteInstance(user)

    try {
      // notify db that the worker is active and check current user override settings
      const dbTrade = await withRemoteRetry(async () => tradeHeartbeat(dbId))
      if (dbTrade.user_override === USER_OVERRIDE.ABORT) {
        return Promise.resolve(
          '🟢 [deltaNeutralExitStrat] Terminating Delta checker as status ABORTed'
        )
      }
    } catch (error) {
      // harmless error, log and continue processing
      console.log('🔴 [deltaNeutralExitStrat] tradeHeartbeat error', error)
    }

    const legsOrders = rawKiteOrdersResponse
    // console.log('legsOrders', logDeep(legsOrders))
    // check here if the open positions include these legs
    // and quantities should be greater than equal to `legsOrders`
    // if not, resolve this checker assuming the user has squared off the positions themselves

    const tradingSymbols = legsOrders.map(order => order.tradingsymbol)
    const callOptionSymbol = tradingSymbols.find(item => item.indexOf('CE') >= 0);
    const putOptionSymbol = tradingSymbols.find(item => item.indexOf('PE') >= 0);

    // [TODO] fetch the option chain here
    // get delta of tradingSymbols and difference between them
    // if difference exceeds user delta
    // then trigger exit condition

    // get expiry of traded instrument
    // either I can do that from kite instrument table (which should be quick loookup from CSV json)
    // or pass it on from fn to fn
    const expiryInKiteFormat = await getSortedMatchingIntrumentsData({ nfoSymbol:instrument, tradingsymbol: tradingSymbols[0] })
    const expiryDate = expiryInKiteFormat[0].expiry;
    const expiryInAngelOneFormat = dayjs(expiryDate).format('DDMMMYYYY').toUpperCase()

    const optionChain = await getOptionChain({ instrument, expiry: expiryInAngelOneFormat })
    const chainCallOption = optionChain.find(chainItem =>
      chainItem.optionType === 'CE' && callOptionSymbol!.indexOf(`${chainItem.strikePrice}`)! >= 0
    )!
    const chainPutOption = optionChain.find(chainItem =>
      chainItem.optionType === 'PE' && putOptionSymbol!.indexOf(`${chainItem.strikePrice}`)! >= 0
    )!
    const deltaDiff = Math.abs(chainCallOption.delta - Math.abs(chainPutOption.delta)) * 100
    if (deltaDiff < deltaStrikes!) {
      const rejectMsg = `🟢 [deltaNeutralExitStrat] deltaDiff (${deltaDiff}) < threshold (${deltaStrikes!})`
      // update db trade with new delta diff
      // and expose it in the UI
      try {
        await withRemoteRetry(async () =>
          patchTradeWithDeltaDiff({
            dbId,
            deltaDiff
          })
        )
      } catch (error) {}

      await delay(ms(60))
      await addToNextQueue(initialJobData, {
        _nextTradingQueue: EXIT_TRADING_Q_NAME,
        rawKiteOrdersResponse,
        squareOffOrders
      })
      return Promise.resolve(rejectMsg)
    }

    // terminate the checker
    const exitMsg = `☢️ [deltaNeutralExitStrat] triggered!)`
    console.log(exitMsg)

    return doSquareOffPositions(squareOffOrders!, kite, initialJobData)
  } catch (e) {
    console.log('☢️ [deltaNeutralExitStrat] terminated', e)
    return Promise.resolve(e)
  }
}

export default deltaNeutralExitStrat
