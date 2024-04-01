import withSession from '../../lib/session'
import { syncGetKiteInstance } from '../../lib/utils'

export default withSession(async (req, res) => {
  const user = req.session.get('user')

  if (!user) {
    return res.status(401).send('Unauthorized')
  }

  const kite = await getInvesBrokerInstance(BrokerName.KITE)

  const { id: orderId } = req.query

  const orderHistory = await kite.getOrderHistory({
    orderId: orderId,
    kiteAccessToken: user?.session.accessToken
  })
  res.json(orderHistory.reverse())
})

// 210428200252388
