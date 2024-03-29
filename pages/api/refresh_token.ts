// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

import axios from 'axios'
import { KiteConnect } from 'kiteconnect'
import { storeAccessTokenRemotely } from '../../lib/utils'
import getInvesBrokerInstance from '../../lib/invesBroker'
import { BrokerName } from 'inves-broker'

const DATABASE_HOST_URL = process.env.DATABASE_HOST_URL
const KITE_API_SECRET = process.env.KITE_API_SECRET
const KITE_API_KEY = process.env.KITE_API_KEY
const SIGNALX_API_KEY = process.env.SIGNALX_API_KEY

const runner = async (req, res) => {
  const storedTokens = await axios(
    `${DATABASE_HOST_URL}/pvt_${SIGNALX_API_KEY}/tokens`
  )
  const { data } = storedTokens
  const [latestRecord] = data
  const { access_token, refresh_token } = latestRecord

  const kc = await getInvesBrokerInstance(BrokerName.KITE)

  try {
    // see if we're able to fetch profile with the access token
    // in case access token is expired, then log out the user
    await kc.getProfile({
      kiteAccessToken: access_token
    })
  } catch (e) {
    console.log('access token expired')
    const responseOnRenew = await kc.renewAccessToken(
      access_token,
      refresh_token
    )
    // then store access token remotely for other services to use it
    await storeAccessTokenRemotely(
      responseOnRenew.access_token as string,
      responseOnRenew.refresh_token
    )
  }

  res.json({ status: 'ok' })
}

export default runner
