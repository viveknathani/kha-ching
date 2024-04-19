import * as invesBroker from 'inves-broker'
import { redisConnection } from './queue'
import { REDIS_KEYS } from './constants'
import memoizee from 'memoizee'

export async function getInvesBrokerInstance (
  brokerName: invesBroker.BrokerName
): Promise<invesBroker.Broker> {
  const iConnectParams = {
    name: invesBroker.BrokerName.KITE,
    config: {}
  }
  switch (brokerName) {
    case invesBroker.BrokerName.KITE: {
      iConnectParams.name = invesBroker.BrokerName.KITE
      iConnectParams.config = {
        kiteAPIKey: process.env.KITE_API_KEY,
        kiteAPISecret: process.env.KITE_API_SECRET
      }
      break
    }
    case invesBroker.BrokerName.DHAN: {
      iConnectParams.name = invesBroker.BrokerName.DHAN
      iConnectParams.config = {
        dhanPartnerId: process.env.DHAN_PARTNER_ID,
        dhanPartnerSecret: process.env.DHAN_PARTNER_SECRET
      }
      break
    }
    case invesBroker.BrokerName.PAYTM_MONEY: {
      iConnectParams.name = invesBroker.BrokerName.PAYTM_MONEY
      iConnectParams.config = {
        paytmMoneyAPIKey: process.env.PAYTM_API_KEY,
        paytmMoneyAPISecret: process.env.PAYTM_API_SECRET
      }
      break
    }
    default: {
      throw new Error('not supported broker')
    }
  }
  const broker = invesBroker.IConnect(iConnectParams.name, iConnectParams.config);
  if (brokerName !== invesBroker.BrokerName.KITE) {
    await broker.setSecurityList(await getSecurityList(brokerName));
  }
  return broker;
}

export async function fetchAndSetSecurityLists () {
  const dhan = await getInvesBrokerInstance(invesBroker.BrokerName.DHAN)
  const dhanList = await dhan.getSecurityList()
  await redisConnection.get(
    REDIS_KEYS.DHAN_SECURITY_LIST,
    JSON.stringify(dhanList)
  )
}

export const getSecurityList = memoizee(
  async (brokerName: invesBroker.BrokerName): Promise<any> => {
    let securityList: Record<string, any> = {}
    switch (brokerName) {
      case invesBroker.BrokerName.DHAN: {
        const data = await redisConnection.get(REDIS_KEYS.DHAN_SECURITY_LIST)
        if (data && data !== '') {
          securityList = JSON.parse(data)
        }
        break
      }
      default: {
        break
      }
    }

    return securityList
  },
  {
    promise: true
  }
)
