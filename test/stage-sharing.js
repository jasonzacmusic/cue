// Cover the web-call picker, including a pending selection when Live ends.
const assert = require('node:assert/strict');
const { desktopCapturer, session } = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
module.exports = async c => {
  const list = desktopCapturer.getSources;
  try {
    await wait(700);
    const f = c.addFolder({name:'Camera lesson'}).folder;
    const ses = session.fromPartition('persist:' + f.id);
    let handler, offer;
    const register = ses.setDisplayMediaRequestHandler.bind(ses);
    ses.setDisplayMediaRequestHandler = fn => { handler = fn; register(fn); };
    c.setFolder(f.id);
    const t = c.openTab({url:'data:text/html,Stage',identity:f.id});
    c.command('cue-add',{id:t.id}); c.agentApi.livequeue('enter');
    const stageId = c.stage().getMediaSourceId();
    desktopCapturer.getSources = async () => [{id:'screen:1:0',name:'Desktop'},{id:'window:9:0',name:'Private window'},{id:stageId,name:'Cue Stage'}];
    const ui=c.ui().webContents, send=ui.send.bind(ui);
    ui.send=(ch,...args)=>{if(ch==='ui:event' && args[0]==='share-picker')offer=args[1];return send(ch,...args);};
    async function request() {
      let result;
      handler({}, answer => {result=answer;}); await wait(60);
      assert.deepEqual(offer.tabs,[]);
      assert.deepEqual(offer.sources.map(s => s.id),[stageId]);
      return () => result;
    }
    let result = await request();
    c.command('share-choose',{requestId:offer.requestId,sourceId:'screen:1:0'});
    assert.deepEqual(result(),{});
    result = await request();
    c.command('share-choose',{requestId:offer.requestId,sourceId:stageId});
    assert.equal(result().video.id,stageId);
    result = await request();
    c.agentApi.livequeue('leave');
    c.command('share-choose',{requestId:offer.requestId,sourceId:stageId});
    assert.deepEqual(result(),{});
    console.log('PASS Live share offers only Stage, refuses other choices and expires when Live ends');
    c.app.quit();
  } catch(e) {console.error(e); c.app.exit(1);}
  finally {desktopCapturer.getSources=list;}
};
