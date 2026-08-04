/**
 * 一块业务能力域，拥有一组工具、一个页面和一段提示词。
 *
 * 模块存在的意义是把模型的选择空间压小。每轮最多只暴露少数几个模块（见
 * `MAX_CANDIDATE_MODULES`），模型是在一把相关工具里挑，而不是在整个产品的所有
 * 工具里挑——这既更便宜，选错的概率也显著更低。
 *
 * @typeParam TContext 该模块 {@link PageAdapter} 产出的形状。
 */
export interface ModuleDefinition<TContext = unknown> {
  /** 注册表内唯一的稳定标识。会出现在工具函数名里。 */
  id: string
  /** 给界面看的可读标签，同时参与模糊候选匹配。 */
  title: string
  /** 该模块覆盖什么。会发给模型，也参与模糊匹配。 */
  description: string
  /**
   * 能把该模块直接钉成候选的精确关键词。
   *
   * 在任何模型调用**之前**用子串匹配，因此一个选得好的别名能零成本消掉整整一轮歧义。
   */
  aliases: string[]
  /** 该模块拥有的路由名。第一项被当作导航与页面同步的规范页面。 */
  routes: string[]
  /**
   * 控制整个模块的权限。缺少权限的用户看不到模块，也看不到它的任何工具。
   * 每个工具自身的权限必须是这里的子集。
   */
  permissions: string[]
  /**
   * 模块级系统提示词，该模块成为候选时注入。
   *
   * 内容应该是**规则**（字段语义、默认值、消歧方式），而不是数据——数据属于
   * {@link formatContext}。
   */
  prompt: string
  /** 示例语句。用于模糊候选匹配，也可供宿主界面做提示。 */
  examples: string[]
  /**
   * 把实时页面快照渲染成给模型看的文本。
   *
   * 结果会以 **user** 角色注入并显式标注为不可信，因为它含有业务数据（客户名、备注），
   * 攻击者可以通过普通产品表单在里面种下指令样文本。绝不要返回任何你希望模型当作
   * 指令执行的内容。
   */
  formatContext(
    context: TContext,
    signal?: AbortSignal
  ): string | Promise<string>
}
