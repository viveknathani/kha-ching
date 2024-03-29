import { BrokerName } from 'inves-broker'
import getInvesBrokerInstance from '../../lib/invesBroker'
import withSession from '../../lib/session'
import { syncGetKiteInstance } from '../../lib/utils'

export default withSession(async (req, res) => {
  const user = req.session.get('user')

  if (!user) {
    return res.status(401).send('Unauthorized')
  }

  const kite = await getInvesBrokerInstance(BrokerName.KITE)
  const positions = await kite.getPositions({
    kiteAccessToken: user?.session.accessToken
  })

  const { net } = positions
  const misPositions = net.filter(position => position.product === 'MIS')

  res.json(misPositions)
})
