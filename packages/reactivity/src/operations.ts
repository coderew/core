// using literal strings instead of numbers so that it's easier to inspect
// debugger events

// 因为什么收集
export const enum TrackOpTypes {
  // 如：obj.a
  GET = 'get',
  // 如：a in obj
  HAS = 'has',
  // 如：Object.keys(a)
  ITERATE = 'iterate'
}

// 因为什么重新触发
export const enum TriggerOpTypes {
  // 如修改：obj.a = 1
  SET = 'set',
  // 如新增：obj.b = 1
  ADD = 'add',
  // 如删除：delete obj.a
  DELETE = 'delete',
  // 在集合中使用，如：map.clear()
  CLEAR = 'clear'
}
